import { Plugin, WorkspaceWindow, Notice, MarkdownPostProcessorContext } from 'obsidian';
import { TikzjaxPluginSettings, DEFAULT_SETTINGS, TikzjaxSettingTab } from "./settings";
import { optimize } from "./svgo.browser";

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as localForage from "localforage";
import { createHash } from 'crypto';

export default class TikzjaxPlugin extends Plugin {
	settings: TikzjaxPluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TikzjaxSettingTab(this.app, this));

		this.addSyntaxHighlighting();
		
		this.registerMarkdownCodeBlockProcessor("tikz", this.processLatexCodeBlock.bind(this));
		this.registerMarkdownCodeBlockProcessor("latex", this.processLatexCodeBlock.bind(this));
	}

	onunload() {
		this.removeSyntaxHighlighting();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	getHash(source: string) {
		return createHash('md5').update(source).digest('hex');
	}

	async processLatexCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const hash = this.getHash(source);
		try {
			const cached = await localForage.getItem<string>(hash);
			if (cached) {
				this.renderSvg(el, cached);
				return;
			}
		} catch (err) {
			console.error("TikZJax cache read error", err);
		}

		const texContent = source;

		console.log("Compiling LaTeX", texContent);

		const tempDir = await fs.mkdtemp(join(tmpdir(), 'tikzjax-'));
		const texFile = join(tempDir, 'doc.tex');
		const dviFile = join(tempDir, 'doc.dvi');
		const pdfFile = join(tempDir, 'doc.pdf');

		await fs.writeFile(texFile, texContent);

		const compile = new Promise<string>((resolve, reject) => {
			const env = Object.assign({}, process.env);
			
			// Change from --pdf to direct DVI to bypass GhostScript dependence in MiKTeX dvisvgm
			// We also switch the compiler default dynamically from pdflatex to latex if it is default
			const compilerPath = this.settings.compilerPath === 'pdflatex' ? 'latex' : this.settings.compilerPath;

			exec(`${compilerPath} -interaction=nonstopmode -halt-on-error -output-directory="${tempDir}" "${texFile}"`, { cwd: tempDir, env }, (error, stdout, stderr) => {
				if (error) {
					console.error("latex error", stdout, stderr);
					reject("LaTeX compilation failed: " + error.message + "\n\n" + stdout);
				} else {
					exec(`${this.settings.dvisvgmPath} --no-fonts -e -o "doc.svg" "${dviFile}"`, { cwd: tempDir, env }, async (error, stdout, stderr) => {
						if (error) {
							console.error("dvisvgm error", stdout, stderr);
							reject("dvisvgm failed: " + error.message + "\n\n" + stdout);
						} else {
							try {
								const svgData = await fs.readFile(join(tempDir, 'doc.svg'), "utf8");
								resolve(svgData);
							} catch (e) {
								reject("Failed to read SVG: " + e);
							}
						}
					});
				}
			});
		});

		try {
			let svg = await compile;
			svg = this.optimizeSVG(svg);
			await localForage.setItem(hash, svg);
			this.renderSvg(el, svg);
		} catch (e) {
			console.error(e);
			el.createEl("pre").createEl("code", { text: e as string });
		} finally {
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} catch(e) {}
		}
	}

	renderSvg(el: HTMLElement, svg: string) {
		const container = el.createDiv({ cls: 'tikz-container' });
		if (this.settings.invertColorsInDarkMode) {
			svg = this.colorSVGinDarkMode(svg);
		}
		container.innerHTML = svg;
	}

	addSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo.push({name: "Tikz", mime: "text/x-latex", mode: "stex"});
		// @ts-ignore
		window.CodeMirror.modeInfo.push({name: "LaTeX", mime: "text/x-latex", mode: "stex"});
	}

	removeSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo = window.CodeMirror.modeInfo.filter((el: any) => el.name != "Tikz" && el.name != "LaTeX");
	}

	tidyTikzSource(tikzSource: string) {

		// Remove non-breaking space characters, otherwise we get errors
		const remove = "&nbsp;";
		tikzSource = tikzSource.replaceAll(remove, "");


		let lines = tikzSource.split("\n");

		// Trim whitespace that is inserted when pasting in code, otherwise TikZJax complains
		lines = lines.map(line => line.trim());

		// Remove empty lines
		lines = lines.filter(line => line);


		return lines.join("\n");
	}


	colorSVGinDarkMode(svg: string) {
		// Replace the color "black" with currentColor (the current text color)
		// so that diagram axes, etc are visible in dark mode
		// And replace "white" with the background color

		svg = svg.replaceAll(/("#000"|"black")/g, `"currentColor"`)
				.replaceAll(/("#fff"|"white")/g, `"var(--background-primary)"`);

		return svg;
	}


	optimizeSVG(svg: string) {
		// Optimize the SVG using SVGO
		// Fixes misaligned text nodes on mobile

		return optimize(svg, {plugins:
			[
				{
					name: 'preset-default',
					params: {
						overrides: {
							// Don't use the "cleanupIDs" plugin
							// To avoid problems with duplicate IDs ("a", "b", ...)
							// when inlining multiple svgs with IDs
							cleanupIDs: false
						}
					}
				}
			]
		// @ts-ignore
		}).data;
	}
}

