import { App, PluginSettingTab, Setting, Notice} from 'obsidian';
import TikzjaxPlugin from "./main";
import * as localForage from "localforage";


export interface TikzjaxPluginSettings {
	invertColorsInDarkMode: boolean;
	compilerPath: string;
	dvisvgmPath: string;
}

export const DEFAULT_SETTINGS: TikzjaxPluginSettings = {
	invertColorsInDarkMode: true,
	compilerPath: 'pdflatex',
	dvisvgmPath: 'dvisvgm'
}


export class TikzjaxSettingTab extends PluginSettingTab {
	plugin: TikzjaxPlugin;

	constructor(app: App, plugin: TikzjaxPlugin) {
		super(app, plugin);
		this.plugin = plugin;


		// Configure localForage if it hasn't been configured by TikZJax already
		// The try-catch block fixes the plugin failing to load on mobile
		try {
			localForage.config({ name: 'TikzJax', storeName: 'svgImages' });
		} catch (error) {
			console.log(error);
		}
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

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
			.setName('LaTeX Compiler Path')
			.setDesc('Path to the LaTeX compiler (e.g., pdflatex). If it is in your PATH, you can just use the command name.')
			.addText(text => text
				.setPlaceholder('pdflatex')
				.setValue(this.plugin.settings.compilerPath)
				.onChange(async (value) => {
					this.plugin.settings.compilerPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('dvisvgm Path')
			.setDesc('Path to the dvisvgm executable.')
			.addText(text => text
				.setPlaceholder('dvisvgm')
				.setValue(this.plugin.settings.dvisvgmPath)
				.onChange(async (value) => {
					this.plugin.settings.dvisvgmPath = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName('Clear cached SVGs')
			.setDesc('SVGs rendered with TikZJax are stored in a database, so diagrams don\'t have to be re-rendered from scratch every time you open a page. Use this to clear the cache and force all diagrams to be re-rendered.')
			.addButton(button => button
				.setIcon("trash")
				.setTooltip("Clear cached SVGs")
				.onClick(async () => {
					localForage.clear((err) => {
						if (err) {
							console.log(err);
							new Notice(err, 3000);
						}
						else {
							new Notice("TikZJax: Successfully cleared cached SVGs.", 3000);
						}
					});
				}));
	}
}
