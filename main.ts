import { Plugin, MarkdownPostProcessorContext } from 'obsidian';
import { TikzjaxPluginSettings, DEFAULT_SETTINGS, TikzjaxSettingTab } from "./settings";

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiagramCache } from './cache';
import { createHash } from 'node:crypto';

export interface CommandOutput {
	stdout: string;
	stderr: string;
}

export class CommandExecutionError extends Error {
	stdout: string;
	stderr: string;

	constructor(message: string, stdout = '', stderr = '') {
		super(message);
		this.name = 'CommandExecutionError';
		this.stdout = stdout;
		this.stderr = stderr;
		Object.setPrototypeOf(this, CommandExecutionError.prototype);
	}
}

function runCommand(
	file: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
): Promise<CommandOutput> {
	return new Promise((resolve, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			const stdoutStr = typeof stdout === 'string' ? stdout : '';
			const stderrStr = typeof stderr === 'string' ? stderr : '';
			if (error) {
				reject(new CommandExecutionError(error.message, stdoutStr, stderrStr));
			} else {
				resolve({
					stdout: stdoutStr,
					stderr: stderrStr
				});
			}
		});
	});
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export default class TikzjaxPlugin extends Plugin {
	settings: TikzjaxPluginSettings = Object.assign({}, DEFAULT_SETTINGS);
	cache: DiagramCache = new DiagramCache();

	override onload(): void {
		void this.loadSettings();
		this.addSettingTab(new TikzjaxSettingTab(this.app, this));

		this.addSyntaxHighlighting();

		this.registerMarkdownCodeBlockProcessor("tikz", (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			return this.processLatexCodeBlock(source, el, ctx);
		});
		this.registerMarkdownCodeBlockProcessor("latex", (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			return this.processLatexCodeBlock(source, el, ctx);
		});
	}

	override onunload(): void {
		this.removeSyntaxHighlighting();
	}

	async loadSettings(): Promise<void> {
		const loadedData = (await this.loadData()) as Partial<TikzjaxPluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getHash(source: string): string {
		return createHash('md5')
			.update(source + '|' + this.settings.compilerPath + '|' + this.settings.dvisvgmPath)
			.digest('hex');
	}

	tidyTikzSource(source: string): string {
		// Replace non-breaking spaces and other problematic spaces
		let cleaned = source.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ');
		// Normalize line breaks
		cleaned = cleaned.replace(/\r\n/g, '\n');
		return cleaned.trim();
	}

	prepareLatexDocument(rawSource: string): string {
		const source = this.tidyTikzSource(rawSource);

		// If user already wrote a full document, use it as is
		if (/\\documentclass(\[.*?\])?\{.*?\}/.test(source)) {
			return source;
		}

		if (!this.settings.autoWrapSnippet) {
			return source;
		}

		const preamble = (this.settings.defaultPreamble || '').trim();

		// If user provided \begin{document}...\end{document} without \documentclass
		if (/\\begin\{document\}/.test(source)) {
			return `${preamble}\n\n${source}\n`;
		}

		// Otherwise, wrap snippet with preamble and document environment
		return `${preamble}\n\n\\begin{document}\n${source}\n\\end{document}\n`;
	}

	extractLatexError(stdout: string, stderr: string): string {
		const combined = (stdout + '\n' + stderr).trim();
		const lines = combined.split('\n');
		const errorLines: string[] = [];
		let capturing = false;

		for (const line of lines) {
			if (line.startsWith('!')) {
				capturing = true;
				errorLines.push(line);
			} else if (capturing) {
				if (line.trim().length === 0 && errorLines.length > 2) {
					capturing = false;
				} else if (errorLines.length < 10) {
					errorLines.push(line);
				}
			}
		}

		if (errorLines.length > 0) {
			return errorLines.join('\n').trim();
		}
		return 'LaTeX compilation failed. Expand log for details.';
	}

	async testToolchain(): Promise<string> {
		const timeout = Math.max(5, this.settings.timeoutSeconds || 25) * 1000;
		const env = Object.assign({}, process.env);

		let compilerInfo = '';
		try {
			const res = await runCommand(this.settings.compilerPath, ['--version'], { env, timeout });
			compilerInfo = (res.stdout || res.stderr).split('\n')[0].trim();
		} catch (err: unknown) {
			const msg = err instanceof CommandExecutionError ? err.message : String(err);
			throw new Error(`LaTeX compiler "${this.settings.compilerPath}" not found or failed:\n${msg}`);
		}

		let dvisvgmInfo = '';
		try {
			const res = await runCommand(this.settings.dvisvgmPath, ['--version'], { env, timeout });
			dvisvgmInfo = (res.stdout || res.stderr).split('\n')[0].trim();
		} catch (err: unknown) {
			const msg = err instanceof CommandExecutionError ? err.message : String(err);
			throw new Error(`dvisvgm "${this.settings.dvisvgmPath}" not found or failed:\n${msg}`);
		}

		return `Compiler: ${compilerInfo}\ndvisvgm: ${dvisvgmInfo}`;
	}

	async processLatexCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		const texContent = this.prepareLatexDocument(source);
		const hash = this.getHash(texContent);

		try {
			const cached = await this.cache.get(hash);
			if (cached) {
				this.renderSvg(el, cached);
				return;
			}
		} catch (err) {
			console.error("TikZ cache read error", err);
		}

		const tempDir = await fs.mkdtemp(join(tmpdir(), 'tikz-'));
		const texFile = join(tempDir, 'doc.tex');
		const svgFile = join(tempDir, 'doc.svg');

		try {
			await fs.writeFile(texFile, texContent, 'utf8');

			const timeout = Math.max(5, this.settings.timeoutSeconds || 25) * 1000;
			const env = Object.assign({}, process.env);

			const compilerArgs = [
				'-interaction=nonstopmode',
				'-halt-on-error',
				`-output-directory=${tempDir}`,
				texFile
			];

			// 1. Compile LaTeX
			try {
				await runCommand(this.settings.compilerPath, compilerArgs, { cwd: tempDir, env, timeout });
			} catch (compileErr: unknown) {
				const cmdErr = compileErr instanceof CommandExecutionError ? compileErr : null;
				const stdout = cmdErr ? cmdErr.stdout : '';
				const stderr = cmdErr ? cmdErr.stderr : '';
				const summary = this.extractLatexError(stdout, stderr);
				const fullLog = (stdout + '\n' + stderr).trim();
				this.renderError(el, "LaTeX compilation error", summary, fullLog);
				return;
			}

			// 2. Identify output file (dvi, xdv, or pdf)
			const dviPath = join(tempDir, 'doc.dvi');
			const xdvPath = join(tempDir, 'doc.xdv');
			const pdfPath = join(tempDir, 'doc.pdf');

			const dvisvgmArgs = ['--no-fonts', '-e', '-o', 'doc.svg'];

			if (await pathExists(dviPath)) {
				dvisvgmArgs.push(dviPath);
			} else if (await pathExists(xdvPath)) {
				dvisvgmArgs.push(xdvPath);
			} else if (await pathExists(pdfPath)) {
				dvisvgmArgs.push('--pdf', pdfPath);
			} else {
				this.renderError(el, "No output file found", "Neither doc.dvi, doc.xdv, nor doc.pdf was produced.", "");
				return;
			}

			// 3. Convert to SVG with dvisvgm
			try {
				await runCommand(this.settings.dvisvgmPath, dvisvgmArgs, { cwd: tempDir, env, timeout });
			} catch (svgErr: unknown) {
				const cmdErr = svgErr instanceof CommandExecutionError ? svgErr : null;
				const stdout = cmdErr ? cmdErr.stdout : '';
				const stderr = cmdErr ? cmdErr.stderr : '';
				const fullLog = (stdout + '\n' + stderr).trim();
				this.renderError(el, "dvisvgm conversion error", cmdErr ? cmdErr.message : "Failed to convert to SVG", fullLog);
				return;
			}

			// 4. Read and clean SVG
			let svg = await fs.readFile(svgFile, 'utf8');
			svg = this.cleanSvg(svg);

			await this.cache.set(hash, svg);
			this.renderSvg(el, svg);
		} catch (err: unknown) {
			console.error("TikZ rendering error", err);
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(el, "Unexpected error", msg, "");
		} finally {
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} catch {
				// Silently ignore temp cleanup errors
			}
		}
	}

	cleanSvg(svg: string): string {
		return svg
			.replace(/<\?xml[\s\S]*?\?>/i, '')
			.replace(/<!DOCTYPE[\s\S]*?>/i, '')
			.trim();
	}

	renderSvg(el: HTMLElement, svg: string): void {
		el.empty();
		const container = el.createDiv({ cls: 'tikz-container' });
		let processedSvg = svg;
		if (this.settings.invertColorsInDarkMode) {
			processedSvg = this.colorSVGinDarkMode(processedSvg);
		}

		try {
			const parser = new DOMParser();
			const parsedDoc = parser.parseFromString(processedSvg, "image/svg+xml");
			const svgEl = parsedDoc.documentElement;

			if (svgEl && svgEl.nodeName.toLowerCase() === "svg") {
				// Strip any script elements to prevent code injection
				const scripts = svgEl.querySelectorAll("script");
				for (let i = 0; i < scripts.length; i++) {
					scripts[i].remove();
				}
				container.replaceChildren(svgEl);
			} else {
				this.renderError(el, "SVG parsing error", "The generated SVG output is malformed.", "");
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(el, "SVG rendering error", msg, "");
		}
	}

	renderError(el: HTMLElement, title: string, summary: string, fullLog: string) {
		el.empty();
		const container = el.createDiv({ cls: 'tikz-error' });
		container.createDiv({ cls: 'tikz-error-title', text: title });

		if (summary) {
			container.createEl("pre", { cls: 'tikz-error-summary', text: summary });
		}

		if (fullLog) {
			const details = container.createEl("details");
			details.createEl("summary", { text: "Full compilation log" });
			details.createEl("pre", { cls: 'tikz-error-log', text: fullLog });
		}
	}

	addSyntaxHighlighting() {
		// Guard against undefined CodeMirror in CM6 / modern Obsidian
		const codeMirrorObj = (window as unknown as { CodeMirror?: { modeInfo?: Array<{ name: string; mime: string; mode: string }> } }).CodeMirror;
		if (codeMirrorObj && Array.isArray(codeMirrorObj.modeInfo)) {
			const hasTikz = codeMirrorObj.modeInfo.some(m => m.name === "Tikz");
			if (!hasTikz) {
				codeMirrorObj.modeInfo.push({ name: "Tikz", mime: "text/x-latex", mode: "stex" });
			}
			const hasLatex = codeMirrorObj.modeInfo.some(m => m.name === "LaTeX");
			if (!hasLatex) {
				codeMirrorObj.modeInfo.push({ name: "LaTeX", mime: "text/x-latex", mode: "stex" });
			}
		}
	}

	removeSyntaxHighlighting() {
		const codeMirrorObj = (window as unknown as { CodeMirror?: { modeInfo?: Array<{ name: string }> } }).CodeMirror;
		if (codeMirrorObj && Array.isArray(codeMirrorObj.modeInfo)) {
			codeMirrorObj.modeInfo = codeMirrorObj.modeInfo.filter(
				m => m.name !== "Tikz" && m.name !== "LaTeX"
			);
		}
	}

	colorSVGinDarkMode(svg: string): string {
		return svg
			.replace(/(["':\s])(#000000|#000|black)(["';\s])/gi, '$1currentColor$3')
			.replace(/(["':\s])(#ffffff|#fff|white)(["';\s])/gi, '$1var(--background-primary)$3');
	}
}
