import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import TikzjaxPlugin from "./main";

export interface TikzjaxPluginSettings {
	invertColorsInDarkMode: boolean;
	compilerPath: string;
	dvisvgmPath: string;
	defaultPreamble: string;
	autoWrapSnippet: boolean;
	timeoutSeconds: number;
}

export const DEFAULT_PREAMBLE = `\\documentclass[tikz, border=2pt]{standalone}
\\usepackage{amsmath,amssymb}
\\usepackage{tikz}
`;

export const DEFAULT_SETTINGS: TikzjaxPluginSettings = {
	invertColorsInDarkMode: true,
	compilerPath: 'latex',
	dvisvgmPath: 'dvisvgm',
	defaultPreamble: DEFAULT_PREAMBLE,
	autoWrapSnippet: true,
	timeoutSeconds: 25
};

export class TikzjaxSettingTab extends PluginSettingTab {
	plugin: TikzjaxPlugin;

	constructor(app: App, plugin: TikzjaxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions() {
		return [
			{
				name: 'LaTeX compiler path',
				desc: 'Path or executable name for the LaTeX compiler (default: latex).',
				control: {
					type: 'text',
					key: 'compilerPath',
					placeholder: 'latex',
				},
			},
			{
				name: 'dvisvgm path',
				desc: 'Path or executable name for dvisvgm (default: dvisvgm).',
				control: {
					type: 'text',
					key: 'dvisvgmPath',
					placeholder: 'dvisvgm',
				},
			},
			{
				name: 'Auto-wrap snippets',
				desc: 'When enabled, code blocks without \\documentclass are automatically wrapped with default preamble.',
				control: {
					type: 'toggle',
					key: 'autoWrapSnippet',
				},
			},
			{
				name: 'Default preamble',
				desc: 'LaTeX preamble used when wrapping code blocks that do not specify a \\documentclass.',
				control: {
					type: 'textarea',
					key: 'defaultPreamble',
					placeholder: DEFAULT_PREAMBLE,
					rows: 6,
				},
			},
			{
				name: 'Compilation timeout (seconds)',
				desc: 'Maximum time in seconds to wait for LaTeX and dvisvgm before aborting.',
				control: {
					type: 'number',
					key: 'timeoutSeconds',
					min: 5,
					defaultValue: 25,
				},
			},
			{
				name: 'Invert dark colors in dark mode',
				desc: 'Invert dark colors in diagrams (e.g. axes, arrows) when in dark mode.',
				control: {
					type: 'toggle',
					key: 'invertColorsInDarkMode',
				},
			},
			{
				name: 'Test LaTeX environment',
				desc: 'Test whether your LaTeX compiler and dvisvgm can be found and executed.',
				action: () => {
					void (async () => {
						try {
							const result = await this.plugin.testToolchain();
							new Notice(`LaTeX Environment Test:\n\n${result}`, 7000);
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`LaTeX Environment Test Failed:\n\n${msg}`, 8000);
						}
					})();
				},
			},
			{
				name: 'Clear cached SVGs',
				desc: 'Clear the local diagram database to force all diagrams to re-render.',
				action: () => {
					void (async () => {
						try {
							await this.plugin.cache.clear();
							new Notice("Successfully cleared cached SVGs.", 3000);
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Error clearing cache: ${msg}`, 4000);
						}
					})();
				},
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('LaTeX Compiler Path')
			.setDesc('Path to the LaTeX compiler (default: latex). If it is in your PATH, you can just use the executable name. For absolute paths on Windows, e.g. C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latex.exe')
			.addText(text => text
				.setPlaceholder('latex')
				.setValue(this.plugin.settings.compilerPath)
				.onChange(async (value) => {
					this.plugin.settings.compilerPath = value.trim() || 'latex';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('dvisvgm Path')
			.setDesc('Path to the dvisvgm executable (default: dvisvgm). If it is in your PATH, you can just use the command name.')
			.addText(text => text
				.setPlaceholder('dvisvgm')
				.setValue(this.plugin.settings.dvisvgmPath)
				.onChange(async (value) => {
					this.plugin.settings.dvisvgmPath = value.trim() || 'dvisvgm';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Test LaTeX Environment')
			.setDesc('Test whether your LaTeX compiler and dvisvgm can be found and executed.')
			.addButton(button => button
				.setButtonText("Test Toolchain")
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Testing...");
					try {
						const result = await this.plugin.testToolchain();
						new Notice(`LaTeX Environment Test:\n\n${result}`, 7000);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`LaTeX Environment Test Failed:\n\n${msg}`, 8000);
					} finally {
						button.setDisabled(false);
						button.setButtonText("Test Toolchain");
					}
				}));

		new Setting(containerEl)
			.setName('Auto-wrap Snippets')
			.setDesc('When enabled, code blocks without \\documentclass are automatically wrapped with the Default Preamble and \\begin{document}...\\end{document}.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoWrapSnippet)
				.onChange(async (value) => {
					this.plugin.settings.autoWrapSnippet = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default Preamble')
			.setDesc('LaTeX preamble used when wrapping code blocks that do not specify a \\documentclass.')
			.addTextArea(text => {
				text
					.setPlaceholder(DEFAULT_PREAMBLE)
					.setValue(this.plugin.settings.defaultPreamble)
					.onChange(async (value) => {
						this.plugin.settings.defaultPreamble = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.cols = 50;
			});

		new Setting(containerEl)
			.setName('Compilation Timeout')
			.setDesc('Maximum time in seconds to wait for LaTeX and dvisvgm to finish before aborting (default: 25).')
			.addText(text => text
				.setPlaceholder('25')
				.setValue(String(this.plugin.settings.timeoutSeconds))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.timeoutSeconds = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Invert dark colors in dark mode')
			.setDesc('Invert dark colors in diagrams (e.g. axes, arrows) when in dark mode, so that they are visible.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.invertColorsInDarkMode)
				.onChange(async (value) => {
					this.plugin.settings.invertColorsInDarkMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Clear cached SVGs')
			.setDesc('Clear the local diagram database to force all diagrams to re-render.')
			.addButton(button => button
				.setIcon("trash")
				.setTooltip("Clear cached SVGs")
				.onClick(async () => {
					try {
						await this.plugin.cache.clear();
						new Notice("Successfully cleared cached SVGs.", 3000);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`Error clearing cache: ${msg}`, 4000);
					}
				}));
	}
}
