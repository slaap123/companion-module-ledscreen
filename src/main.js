const { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } = require('@companion-module/base')
const { PNG } = require('pngjs')

class LEDScreenModule extends InstanceBase {
	async init(config) {
		this.config = config
		this.selectedScreen = null
		this.serverIp = null
		this.serverPort = null
		this.screens = {}
		this.restore = {}
		this.currentShow = {} // screenKey -> show id currently on that screen
		this.logos = {}
		this.titles = [] // names of the title presets on the LedScreen server
		this.currentTitle = null
		this.buttonShowMap = {} // Track show values per button
		this.previews = {} // screenKey -> { width, height, data, scaled }
		this.previewSubscriptions = {} // feedbackId -> preview target
			this.showOptions = [
			{ id: 0, label: 'Anu' },
			{ id: 1, label: 'Logo' },
			{ id: 2, label: 'Dia' },
			{ id: 3, label: 'Talm' },
			{ id: 4, label: 'Hidden' },
			{ id: 5, label: 'SB' },
			{ id: 6, label: 'IsoLynx' },
			{ id: 7, label: 'TOD' },
			{ id: 8, label: 'Title' },
			{ id: 9, label: 'Ruler' },
			{ id: 10, label: 'NDI' },
			{ id: 11, label: 'FTB' },
			{ id: 12, label: 'DEBUG' },
		]
		this.CurrentIsGroup = false;
		this.Groups = {};
		this.talmBaseDepth = parseInt(config.talmDepth) || 60 // cm, like the base on the Talm control page
		this.talmBaseHeight = parseInt(config.talmHeight) || 200 // cm
		this.talmLastSet = null // seconds of the last chosen timer preset, sent along with start
		this.noSelectionFlash = {} // controlId -> timer, buttons pressed while no screen/group was selected
		this.talmActionOffsets = {} // action id -> { controlId, kind: 'depth' | 'height', offset }, for the button text
		this.initUDPListener()
		this.updateActions()
		this.updateVariables()
		this.updateFeedbacks()
		this.startPolling()
		this.startPreviewPolling()
	}

	startPreviewPolling() {
		if (this.previewTimer) {
			clearInterval(this.previewTimer)
			this.previewTimer = null
		}
		this.previews = {}
		this.checkFeedbacks('screen_preview')
		if (!this.config.enablePreviews) return

		// 0 = no timed updates, previews then only update when a button is pressed
		const seconds = parseFloat(this.config.previewInterval)
		const interval = (Number.isNaN(seconds) ? 2 : seconds) * 1000
		this.previewFetchTimeout = interval > 0 ? Math.max(500, interval) : 2000
		if (interval > 0) {
			this.previewTimer = setInterval(() => this.fetchPreviews(), Math.max(500, interval))
		}
		clearTimeout(this.previewInitTimer)
		this.previewInitTimer = setTimeout(() => this.fetchPreviews(), 50)
	}

	// Called after every button press: fetch the previews now, and once more a moment later
	// so a show that takes a while to appear on the screen is in the preview too
	refreshPreviewsAfterAction() {
		if (!this.config.enablePreviews) return
		clearTimeout(this.previewInitTimer)
        this.previewInitTimer = setTimeout(() => this.fetchPreviews(), 50)
		clearTimeout(this.previewFollowUpTimer)
		this.previewFollowUpTimer = setTimeout(() => this.fetchPreviews(), 1000)
	}

	// Wraps every action callback so the previews are updated after the action ran
	withPreviewRefresh(actions) {
		for (const action of Object.values(actions)) {
			const callback = action.callback
			action.callback = async (...args) => {
				try {
					return await callback(...args)
				} finally {
					this.refreshPreviewsAfterAction()
				}
			}
		}
		return actions
	}

	// A preview target is a screen key, or 'group:<name>' which shows the first screen of that group
	previewTargetToScreenKey(target) {
		if (typeof target === 'string' && target.startsWith('group:')) {
			return (this.Groups[target.substring(6)] || [])[0]
		}
		return target
	}

	async fetchPreviews(timeout = this.previewFetchTimeout || 2000) {
		if (this.previewsInFlight) {
			// a forced update must not get lost: run again once the current fetch is done
			this.previewsRerun = true
			return
		}
		this.previewsInFlight = true
		this.previewsRerun = false
		try {
			const keys = new Set(
				Object.values(this.previewSubscriptions)
					.map((target) => this.previewTargetToScreenKey(target))
					.filter((key) => key !== undefined && this.screens[key]),
			)
			await Promise.all(
				[...keys].map(async (key) => {
					const screen = this.screens[key]
					const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/preview/${screen.Key}`
					try {
						const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
						if (!res.ok) throw new Error(`HTTP ${res.status}`)
						const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()))
						this.previews[key] = { width: png.width, height: png.height, data: png.data, scaled: {} }
					} catch (err) {
						this.log('debug', `Kan preview van scherm ${key} niet laden: ${err.message}`)
						delete this.previews[key]
					}
				}),
			)
			this.checkFeedbacks('screen_preview')
		} finally {
			this.previewsInFlight = false
		}
		if (this.previewsRerun && this.config.enablePreviews) this.fetchPreviews()
	}

	startPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
		}

		this.pollTimer = setInterval(() => {
			this.log('info', 'Updating data')
			this.fetchScreens()
			this.fetchLogo()
			this.fetchTitles()
		}, 60000)
	}

	initUDPListener() {
		this.serverIp = this.config.serverIp
		this.serverPort = this.config.serverPort
		this.fetchScreens()
		this.fetchLogo()
		this.fetchTitles()
	}

	async fetchScreens() {
		try {
			const url = `http://${this.serverIp}:${this.serverPort}/screens/true/`
			const res = await fetch(url)
			const data = await res.json()
			const nscreens = {}
			// rebuilt on every fetch, otherwise each refresh adds the screens to their groups again
			const groups = {}

			this.log('info', `${Object.keys(data).length} schermen geladen`)
			for (const [, screen] of Object.entries(data)) {
				const key = ipPortToKey(screen.IP, screen.Key)
                if (!this.restore[key]) {
					this.restore[key] = screen.Show;
                }
				this.currentShow[key] = Number(screen.Show)
				nscreens[ipPortToKey(screen.IP, screen.Key)] = screen
				for (const group of screen.SendGroups) {
					if(group=="Default") continue;
					if (!groups[group]) {
						groups[group] = [];
					}
					if (!groups[group].includes(key)) groups[group].push(key);
				}
			}

			this.Groups = groups
			this.log('info', `Groups: ${JSON.stringify(this.Groups)}`)
			this.screens = nscreens
			this.checkFeedbacks('screen_show', 'no_selection')
			this.updateScreenNameVariables()
			this.updateActions()
			this.updateFeedbacks()
			this.updatePreset()
			this.updateStatus(InstanceStatus.Ok)
		} catch (err) {
			this.log('error', `Kan schermen niet laden: ${err.message}`)
		}
	}

	async fetchLogo() {
		try {
			const url = `http://${this.serverIp}:${this.serverPort}/images/`
			const res = await fetch(url)
			const data = await res.json()
			this.log('info', `${Object.keys(data).length} logos geladen`)
			this.logos = data
			this.updateActions()
			this.updatePreset()
		} catch (err) {
			this.log('error', `Kan logos niet laden: ${err.message}`)
		}
	}

	// Names of the saved title presets and the active one (needs a LedScreen with the /titles route)
	async fetchTitles() {
		try {
			const res = await fetch(`http://${this.serverIp}:${this.serverPort}/titles`)
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const data = await res.json()
			const names = data.titles || []
			const changed = JSON.stringify(names) !== JSON.stringify(this.titles)
			this.titles = names
			this.setCurrentTitle(data.current ?? null)
			if (changed) {
				this.log('info', `${names.length} titels geladen`)
				this.updateActions()
				this.updatePreset()
			}
		} catch (err) {
			this.log('debug', `Kan titels niet laden: ${err.message}`)
		}
	}

	setCurrentTitle(title) {
		this.currentTitle = title
		this.setVariableValues({ current_title: title ?? '' })
		this.checkFeedbacks('title_active')
	}

	// Makes the named title the active one on every LedScreen computer (each has its own active title)
	async sendTitle(title) {
		const hosts = new Set(
			Object.values(this.screens).map((screen) => `${screen.IP || this.serverIp}:${screen.Port || this.serverPort}`),
		)
		if (hosts.size === 0) hosts.add(`${this.serverIp}:${this.serverPort}`)
		let ok = false
		for (const host of hosts) {
			try {
				const res = await fetch(`http://${host}/settitle/${encodeURIComponent(title)}`)
				if (res.ok) {
					ok = true
				} else if (res.status === 404) {
					this.log('error', `Titel "${title}" bestaat niet op ${host} (of LedScreen is te oud voor titels kiezen)`)
				} else {
					this.log('error', `Fout bij titel zetten op ${host} (${res.status}): ${await res.text()}`)
				}
			} catch (err) {
				this.log('error', `Fout bij titel zetten op ${host}: ${err.message}`)
			}
		}
		if (ok) this.setCurrentTitle(title)
		return ok
	}

	updateVariables() {
		this.setVariableDefinitions(this.buildVariableDefinitions())
		this.setVariableValues({
			last_selected_screen_button_id: null,
			selected_Screen_key: null,
		})
		this.updateTalmVariables()
	}

	updateTalmVariables() {
		this.setVariableValues({
			talm_base_depth: this.talmBaseDepth,
			talm_base_height: this.talmBaseHeight,
			talm_base_height_m: formatHeight(this.talmBaseHeight),
		})
	}

	buildVariableDefinitions() {
		const variables = [
			{ variableId: 'last_selected_screen_button_id', name: 'Laatst Geselecteerd Scherm Knop ID' },
			{ variableId: 'selected_Screen_key', name: 'Laatst Geselecteerd Scherm key' },
			{ variableId: 'talm_base_depth', name: 'Talm basis diepte (cm)' },
			{ variableId: 'talm_base_height', name: 'Talm basis hoogte (cm)' },
			{ variableId: 'talm_base_height_m', name: 'Talm basis hoogte (m)' },
			{ variableId: 'current_title', name: 'Actieve titel' },
		]

		for (const [, screen] of Object.entries(this.screens)) {
			const key = ipPortToKey(screen.IP, screen.Key)
			variables.push({
				variableId: `screen_name_${key}`,
				name: `Schermnaam ${key}`,
			})
		}

		return variables
	}

	updateScreenNameVariables() {
		this.setVariableDefinitions(this.buildVariableDefinitions())

		const values = {}
		for (const [, screen] of Object.entries(this.screens)) {
			const key = ipPortToKey(screen.IP, screen.Key)
			values[`screen_name_${key}`] = screen.Name || `Scherm ${key}`
		}
		this.setVariableValues(values)
	}

	updateFeedbacks() {
		const targetChoices = [
			...Object.entries(this.screens).map(([key, screen]) => ({
				id: key,
				label: screen.Name || `Scherm ${key}`,
			})),
			...Object.keys(this.Groups).map((group) => ({ id: `group:${group}`, label: `Groep ${group}` })),
		]

		const feedbacks = {
			selected_button_highlight: {
				type: 'advanced',
				name: 'Highlight laatst geselecteerde schermknop',
				description: 'Maakt de knop de gekoze kleur als deze de laatst geselecteerde schermknop was.',
				options: [
					{
						type: 'colorpicker',
						label: 'New Background Color',
						id: 'nbgcolor',
						default: combineRgb(0, 0x60, 0),
					},
				],
				affectedProperties: ['bgcolor'],
				callback: (feedback) => {
					const currentButtonId = feedback.controlId
					const lastSelectedButtonId = this.getVariableValue('last_selected_screen_button_id')
					if (currentButtonId && lastSelectedButtonId && currentButtonId === lastSelectedButtonId) {
						return { bgcolor: feedback.options.nbgcolor }
					}
					return {}
				},
			},
			current_show: {
				type: 'advanced',
				name: 'Highlight huidige show',
				description: 'Maakt de knop achtergrond gekleurd als deze de huidige show is.',
				options: [
					{
						type: 'colorpicker',
						label: 'New Background Color',
						id: 'nbgcolor',
						default: combineRgb(0, 0, 0x90),
					},
				],
				affectedProperties: ['bgcolor'],
				callback: (feedback) => {
					const buttonShowId = this.buttonShowMap[feedback.controlId]
					const currentShow = this.restore[this.selectedScreen]
					if (buttonShowId === currentShow) {
						return { bgcolor: feedback.options.nbgcolor }
					}
					return {}
				},
			},
		}
		feedbacks.screen_show = {
			type: 'boolean',
			name: 'Show actief op scherm/groep',
			description:
				'Kleurt de knop als het gekozen scherm (of alle schermen van de groep) de gekozen show tonen.',
			defaultStyle: {
				bgcolor: combineRgb(0xcc, 0x00, 0xcc),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					id: 'target',
					label: 'Scherm of groep',
					default: targetChoices[0]?.id ?? '',
					choices: targetChoices,
				},
				{
					type: 'dropdown',
					id: 'show',
					label: 'Show',
					default: 0,
					choices: this.showOptions,
				},
			],
			callback: (feedback) => {
				const target = feedback.options.target
				const keys =
					typeof target === 'string' && target.startsWith('group:')
						? this.Groups[target.substring(6)] || []
						: [target]
				const show = Number(feedback.options.show)
				return keys.length > 0 && keys.every((key) => this.currentShow[key] === show)
			},
		}
		feedbacks.title_active = {
			type: 'boolean',
			name: 'Titel actief',
			description: 'Kleurt de knop als de gekozen titel de actieve titel is.',
			defaultStyle: {
				bgcolor: combineRgb(0, 0, 0x90),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					id: 'title',
					label: 'Titel',
					default: this.titles[0] ?? '',
					choices: this.titles.map((name) => ({ id: name, label: name })),
					allowCustom: true,
				},
			],
			callback: (feedback) => this.currentTitle !== null && feedback.options.title === this.currentTitle,
		}
		feedbacks.screen_preview = {
			type: 'advanced',
			name: 'Preview van scherm/groep',
			description:
				'Toont de huidige inhoud van het scherm (of het eerste scherm van de groep) als achtergrond. Werkt alleen als previews aan staan in de instellingen.',
			options: [
				{
					type: 'dropdown',
					id: 'target',
					label: 'Scherm of groep',
					default: targetChoices[0]?.id ?? '',
					choices: targetChoices,
				},
				{
					type: 'checkbox',
					id: 'textBand',
					label: 'Donkere balk voor tekst onderaan',
					default: true,
				},
			],
			subscribe: (feedback) => {
				this.previewSubscriptions[feedback.id] = feedback.options.target
			},
			unsubscribe: (feedback) => {
				delete this.previewSubscriptions[feedback.id]
			},
			callback: (feedback) => {
				this.previewSubscriptions[feedback.id] = feedback.options.target
				if (!this.config.enablePreviews) return {}
				const preview = this.previews[this.previewTargetToScreenKey(feedback.options.target)]
				if (!preview) return {}
				const width = feedback.image?.width ?? 72
				const height = feedback.image?.height ?? 72
				// Older feedbacks have no textBand option yet, those keep the band
				const textBand = feedback.options.textBand !== false
				const sizeKey = `${width}x${height}${textBand ? 'band' : ''}`
				if (!preview.scaled[sizeKey]) {
					const png = new PNG({ width, height })
					png.data = scaleToFit(preview, width, height)
					if (textBand) addTextBand(png.data, width, height)
					preview.scaled[sizeKey] = PNG.sync.write(png).toString('base64')
				}
				// png64 instead of imageBuffer: Companion 5 draws imageBuffers on top of the text, png64 below it
				const result = {
					png64: preview.scaled[sizeKey],
					pngalignment: 'center:center',
				}
				// Text goes on the dark band at the bottom so it stays readable over the preview
				if (textBand) result.alignment = 'center:bottom'
				return result
			},
		}
		feedbacks.no_selection = {
			type: 'advanced',
			name: 'Waarschuwing: geen scherm geselecteerd',
			description:
				'Voor knoppen die naar het geselecteerde scherm/groep sturen: kleurt de knop als er niets geselecteerd is, en knippert een foutmelding als de knop dan toch ingedrukt wordt.',
			options: [
				{
					type: 'colorpicker',
					label: 'Kleur zolang niets geselecteerd is',
					id: 'idlecolor',
					default: combineRgb(0x55, 0, 0),
				},
				{
					type: 'colorpicker',
					label: 'Kleur bij indrukken zonder selectie',
					id: 'errorcolor',
					default: combineRgb(255, 0, 0),
				},
				{
					type: 'textinput',
					label: 'Tekst bij indrukken zonder selectie',
					id: 'errortext',
					default: 'Geen scherm!',
				},
			],
			callback: (feedback) => {
				if (this.noSelectionFlash[feedback.controlId]) {
					return {
						bgcolor: feedback.options.errorcolor,
						color: combineRgb(255, 255, 255),
						text: feedback.options.errortext,
					}
				}
				if (!this.hasSelection()) return { bgcolor: feedback.options.idlecolor }
				return {}
			},
		}
		const talmTextOptions = [
			{
				type: 'checkbox',
				id: 'useActionOffset',
				label: 'Offset van de stuur-actie op deze knop gebruiken',
				default: true,
			},
			{
				type: 'number',
				id: 'offset',
				label: 'Offset (cm)',
				default: 0,
				min: -1000,
				max: 1000,
				isVisible: (options) => options.useActionOffset === false,
			},
		]
		feedbacks.talm_depth_text = {
			type: 'advanced',
			name: 'Talm: diepte als knoptekst',
			description:
				'Zet de knoptekst op basis diepte + offset (bijv. 55cm). Standaard de offset van de diepte actie op dezelfde knop.',
			options: talmTextOptions,
			callback: (feedback) => oneLineText(`${this.talmDepth(this.talmTextOffset(feedback, 'depth'))}cm`),
		}
		feedbacks.talm_height_text = {
			type: 'advanced',
			name: 'Talm: hoogte als knoptekst',
			description:
				'Zet de knoptekst op basis hoogte + offset (bijv. 2.00m). Standaard de offset van de hoogte actie op dezelfde knop.',
			options: talmTextOptions,
			callback: (feedback) => oneLineText(formatHeight(this.talmHeight(this.talmTextOffset(feedback, 'height')))),
		}
		this.setFeedbackDefinitions(feedbacks)
	}

	updateActions() {
		const screenChoices = Object.entries(this.screens).map(([key, screen]) => ({
			id: ipPortToKey(screen.IP, screen.Key),
			label: screen.Name || `Scherm ${key}`,
		}))

		const logoChoices = Object.entries(this.logos).map(([key, logo]) => ({
			id: parseInt(key),
			label: logo,
		}))

		const talmTargetOption = {
			type: 'dropdown',
			id: 'target',
			label: 'Scherm of groep',
			default: 'selected',
			choices: [
				{ id: 'selected', label: 'Geselecteerd scherm/groep' },
				...Object.entries(this.screens).map(([key, screen]) => ({
					id: key,
					label: screen.Name || `Scherm ${key}`,
				})),
				...Object.keys(this.Groups).map((group) => ({ id: `group:${group}`, label: `Groep ${group}` })),
			],
		}

		const keepOnOffChoices = [
			{ id: 'keep', label: 'Niet wijzigen' },
			{ id: '1', label: 'Aan' },
			{ id: '0', label: 'Uit' },
		]

		this.setActionDefinitions(this.withPreviewRefresh({
			setZero: {
				name: 'set SB to 0.0',
				callback: async () => {
					await this.sendToAllScreens('/sbzero')
				},
			},
			ShowReaction: {
				name: 'show reaction times',
				callback: async () => {
					await this.sendToAllScreens('/sbreaction')
				},
			},
			set_sb_lines: {
				name: 'Zet aantal SB regels',
				options: [
					{
						type: 'number',
						id: 'lines',
						label: 'Aantal atleet regels',
						default: 6,
						min: 1,
						max: 50,
					},
					{
						type: 'dropdown',
						id: 'title',
						label: 'Titel',
						default: 'keep',
						choices: keepOnOffChoices,
					},
					{
						type: 'dropdown',
						id: 'photo',
						label: 'Foto',
						default: 'keep',
						choices: keepOnOffChoices,
					},
					{
						type: 'textinput',
						id: 'photolines',
						label: 'Foto regels (leeg = niet wijzigen)',
						default: '',
					},
					{
						type: 'checkbox',
						id: 'all',
						label: 'Alle schermen (anders geselecteerd scherm/groep)',
						default: false,
					},
				],
				callback: async (event) => {
					if (!event.options.all && !this.requireSelection(event.controlId)) return
					await this.sendScoreBoardLines(event.options)
				},
			},
			select_screen: {
				name: 'Selecteer scherm',
				options: [
					{
						type: 'dropdown',
						id: 'screen',
						label: 'Kies scherm',
						default: 0,
						choices: screenChoices,
					},
				],
				callback: (event) => {
					var screen = this.screens[event.options.screen];
					var key=ipPortToKey(screen.IP, screen.Key)
					this.log('info', `Geselecteerd scherm: ${key}`);
					this.selectedScreen = key
					this.CurrentIsGroup = false
					this.setVariableValues({
						last_selected_screen_button_id: event.controlId,
						selected_Screen_key: this.selectedScreen,
					})
					this.checkFeedbacks('selected_button_highlight', 'current_show', 'no_selection')
				},
			},
			select_group: {
				name: 'Selecteer groep',
				options: [
					{
						type: 'dropdown',
						id: 'group',
						label: 'Kies groep',
						default: Object.keys(this.Groups)[0] || '',
						choices: Object.keys(this.Groups).map((groupName) => ({
							id: groupName,
							label: groupName,
						})),
					},
				],
				callback: (event) => {
					const groupName = event.options.group
					this.log('info', `Geselecteerde groep: ${groupName}`)
					this.selectedScreen = groupName
					this.CurrentIsGroup = true
					this.setVariableValues({
						last_selected_screen_button_id: event.controlId,
						selected_Screen_key: this.selectedScreen,
					})
					this.checkFeedbacks('selected_button_highlight', 'current_show', 'no_selection')
				},
			},
			send_show: {
				name: 'Stuur show naar geselecteerd scherm',
				options: [
					{
						type: 'dropdown',
						id: 'show',
						label: 'Show type',
						default: 0,
						choices: this.showOptions,
					},
				],
				callback: async (event) => {
					this.buttonShowMap[event.controlId] = event.options.show
					if (!this.requireSelection(event.controlId)) return
					await this.sendShowToScreen(this.selectedScreen, event.options.show)
				},
			},
			send_show_logo: {
				name: 'Stuur show logo+ het logo naar geselecteerd scherm',
				options: [
					{
						type: 'dropdown',
						id: 'logo',
						label: 'logo',
						default: 0,
						choices: logoChoices,
					},
				],
				callback: async (event) => {
					if (!this.requireSelection(event.controlId)) return
					await this.sendShowLogoToScreen(this.selectedScreen, event.options.logo)
				},
			},
			send_show_logo_all: {
				name: 'Stuur show logo+ het logo naar alle schermen',
				options: [
					{
						type: 'dropdown',
						id: 'logo',
						label: 'logo',
						default: 0,
						choices: logoChoices,
					},
				],
				callback: async (event) => {
					await this.sendShowLogoToAllScreens(event.options.logo)
				},
			},
			send_show_all: {
				name: 'Stuur show naar all',
				options: [
					{
						type: 'dropdown',
						id: 'show',
						label: 'Show type',
						default: 0,
						choices: this.showOptions,
					},
					{
						type: 'dropdown',
						id: 'logo',
						label: 'logo',
						choices: logoChoices,
					},
				],
				callback: async (event) => {
					await this.sendShowToAllScreens(event.options.show, event.options.logo)
				},
			},
			restore_screen: {
				name: 'Stuur restore naar geselecteerd scherm',
				callback: async (event) => {
					if (!this.requireSelection(event.controlId)) return
					await this.restoreScreen(this.selectedScreen)
				},
			},
			set_title: {
				name: 'Zet titel (op naam)',
				description: 'Maakt de titel met deze naam de actieve titel, net als Publish op het Title tabblad.',
				options: [
					{
						type: 'dropdown',
						id: 'title',
						label: 'Titel',
						default: this.titles[0] ?? '',
						choices: this.titles.map((name) => ({ id: name, label: name })),
						allowCustom: true,
					},
					{
						type: 'checkbox',
						id: 'show',
						label: 'Ook de Title show op het geselecteerde scherm/groep zetten',
						default: false,
					},
				],
				callback: async (event, context) => {
					const title = (await context.parseVariablesInString(`${event.options.title ?? ''}`)).trim()
					if (title === '') {
						this.log('warn', 'Geen titel gekozen')
						return
					}
					if (event.options.show && !this.requireSelection(event.controlId)) return
					if (!(await this.sendTitle(title))) return
					if (event.options.show) await this.sendShowToScreen(this.selectedScreen, 8)
				},
			},
			restore_screens: {
				name: 'Stuur restore',
				callback: async () => {
					await this.restoreAllScreens()
				},
			},
			talm_set: {
				name: 'Talm: zet timer',
				options: [
					{
						type: 'number',
						id: 'minutes',
						label: 'Minuten',
						default: 1,
						min: 0,
						max: 600,
						step: 0.5,
					},
					talmTargetOption,
				],
				callback: async (event) => {
					const seconds = Math.round(Number(event.options.minutes) * 60)
					this.talmLastSet = seconds
					await this.sendTalm(event.options.target, 'set', seconds, event.controlId)
				},
			},
			talm_settime: {
				name: 'Talm: aftellen tot tijdstip',
				options: [
					{
						type: 'textinput',
						id: 'time',
						label: 'Tijd (UU:MM)',
						default: '12:00',
						useVariables: true,
					},
					talmTargetOption,
				],
				callback: async (event, context) => {
					const time = (await context.parseVariablesInString(event.options.time)).trim()
					if (!/^\d{1,2}:\d{2}$/.test(time)) {
						this.log('warn', `Ongeldige tijd: ${time}`)
						return
					}
					await this.sendTalm(event.options.target, 'settime', time, event.controlId)
				},
			},
			talm_command: {
				name: 'Talm: commando',
				options: [
					{
						type: 'dropdown',
						id: 'command',
						label: 'Commando',
						default: 'start',
						choices: [
							{ id: 'start', label: 'Start' },
							{ id: 'stop', label: 'Stop' },
							{ id: 'reset', label: 'Reset' },
							{ id: 'V', label: 'Geldig (✓)' },
							{ id: 'X', label: 'Ongeldig (✗)' },
							{ id: 'clear', label: 'Clear' },
						],
					},
					talmTargetOption,
				],
				callback: async (event) => {
					const command = event.options.command
					// Like the control page: start sends the last chosen timer preset along
					await this.sendTalm(event.options.target, command, command === 'start' ? this.talmLastSet : undefined, event.controlId)
				},
			},
			talm_depth: {
				name: 'Talm: stuur diepte (basis + offset)',
				options: [
					{
						type: 'number',
						id: 'offset',
						label: 'Offset (cm)',
						default: 0,
						min: -1000,
						max: 1000,
					},
					talmTargetOption,
				],
				subscribe: (action) => this.trackTalmOffset(action, 'depth'),
				unsubscribe: (action) => this.untrackTalmOffset(action),
				callback: async (event) => {
					await this.sendTalm(event.options.target, 'depth', this.talmDepth(event.options.offset), event.controlId)
				},
			},
			talm_depth_base: {
				name: 'Talm: wijzig basis diepte',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Modus',
						default: 'add',
						choices: [
							{ id: 'add', label: 'Ophogen/verlagen met' },
							{ id: 'set', label: 'Zetten op' },
						],
					},
					{
						type: 'number',
						id: 'value',
						label: 'Waarde (cm)',
						default: 5,
						min: -1000,
						max: 1000,
					},
				],
				callback: (event) => {
					const value = Number(event.options.value) || 0
					this.talmBaseDepth = event.options.mode === 'set' ? value : this.talmBaseDepth + value
					this.talmBaseChanged()
				},
			},
			talm_height: {
				name: 'Talm: stuur hoogte (basis + offset)',
				options: [
					{
						type: 'number',
						id: 'offset',
						label: 'Offset (cm)',
						default: 0,
						min: -1000,
						max: 1000,
					},
					talmTargetOption,
				],
				subscribe: (action) => this.trackTalmOffset(action, 'height'),
				unsubscribe: (action) => this.untrackTalmOffset(action),
				callback: async (event) => {
					await this.sendTalm(event.options.target, 'height', this.talmHeight(event.options.offset), event.controlId)
				},
			},
			talm_height_base: {
				name: 'Talm: wijzig basis hoogte',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Modus',
						default: 'add',
						choices: [
							{ id: 'add', label: 'Ophogen/verlagen met' },
							{ id: 'set', label: 'Zetten op' },
						],
					},
					{
						type: 'number',
						id: 'value',
						label: 'Waarde (cm)',
						default: 1,
						min: -1000,
						max: 1000,
					},
				],
				callback: (event) => {
					const value = Number(event.options.value) || 0
					this.talmBaseHeight = event.options.mode === 'set' ? value : this.talmBaseHeight + value
					this.talmBaseChanged()
				},
			},
		}))
	}

	talmDepth(offset) {
		return this.talmBaseDepth + (Number(offset) || 0)
	}

	talmHeight(offset) {
		return this.talmBaseHeight + (Number(offset) || 0)
	}

	// Remembers the offset of a depth/height send action, so the text feedback on the same button can show it
	trackTalmOffset(action, kind) {
		this.talmActionOffsets[action.id] = { controlId: action.controlId, kind, offset: Number(action.options.offset) || 0 }
		this.checkFeedbacks('talm_depth_text', 'talm_height_text')
	}

	untrackTalmOffset(action) {
		delete this.talmActionOffsets[action.id]
		this.checkFeedbacks('talm_depth_text', 'talm_height_text')
	}

	// Offset for a Talm text feedback: the send action's offset on the same button (default), or the feedback's own
	talmTextOffset(feedback, kind) {
		// feedbacks made before this option existed have no value: they follow the action too
		if (feedback.options.useActionOffset !== false) {
			const tracked = Object.values(this.talmActionOffsets).find(
				(entry) => entry.controlId === feedback.controlId && entry.kind === kind,
			)
			if (tracked) return tracked.offset
		}
		return feedback.options.offset
	}

	talmBaseChanged() {
		this.updateTalmVariables()
		this.checkFeedbacks('talm_depth_text', 'talm_height_text')
	}

	// Screen keys for a Talm target: 'selected' (the selected screen/group), 'group:<name>' or a screen key
	talmTargetKeys(target) {
		if (target === 'selected' || target === undefined) {
			if (this.selectedScreen === null) return []
			return this.CurrentIsGroup ? this.Groups[this.selectedScreen] || [] : [this.selectedScreen]
		}
		if (typeof target === 'string' && target.startsWith('group:')) {
			return this.Groups[target.substring(6)] || []
		}
		return [target]
	}

	// True when the selected screen/group points to at least one known screen
	hasSelection() {
		return this.talmTargetKeys('selected').some((key) => this.screens[key])
	}

	// Checks there is a selection; if not, logs it and flashes the pressed button (no_selection feedback)
	requireSelection(controlId) {
		if (this.hasSelection()) return true
		this.flagNoSelection(controlId)
		return false
	}

	flagNoSelection(controlId) {
		this.log('warn', 'Geen scherm geselecteerd')
		if (!controlId) return
		clearTimeout(this.noSelectionFlash[controlId])
		this.noSelectionFlash[controlId] = setTimeout(() => {
			delete this.noSelectionFlash[controlId]
			this.checkFeedbacks('no_selection')
		}, 2000)
		this.checkFeedbacks('no_selection')
	}

	// Posts a Talm action to the screen(s), the same way the Talm control page does
	async sendTalm(target, action, param, controlId) {
		const keys = this.talmTargetKeys(target).filter((key) => this.screens[key])
		if (keys.length === 0) {
			this.flagNoSelection(controlId)
			return
		}
		const body = { action }
		if (param !== undefined && param !== null) body.param = `${param}`
		for (const key of keys) {
			const screen = this.screens[key]
			if (!screen) {
				this.log('error', 'Ongeldig scherm geselecteerd')
				continue
			}
			const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/talm/action/${screen.Key}`
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				})
				if (!res.ok) {
					this.log('error', `Fout bij Talm ${action} (${res.status}): ${await res.text()}`)
				}
			} catch (err) {
				this.log('error', `Fout bij Talm ${action}: ${err.message}`)
			}
		}
	}

	async sendToAllScreens(endpoint) {
		for (const [, screen] of Object.entries(this.screens)) {
			const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}${endpoint}`
			try {
				await fetch(url)
			} catch (err) {
				this.log('error', `Fout bij verzenden: ${err.message}`)
			}
		}
	}

	async sendScoreBoardLines(options) {
		const lines = parseInt(options.lines)
		if (!(lines >= 1)) {
			this.log('warn', `Ongeldig aantal regels: ${options.lines}`)
			return
		}
		const query = new URLSearchParams()
		if (options.title === '0' || options.title === '1') query.set('title', options.title)
		if (options.photo === '0' || options.photo === '1') query.set('photo', options.photo)
		const photoLines = `${options.photolines ?? ''}`.trim()
		if (photoLines !== '') query.set('photolines', photoLines)
		const qs = query.toString()
		const path = `${lines}${qs ? `?${qs}` : ''}`

		let keys
		if (options.all) {
			keys = Object.keys(this.screens)
		} else if (this.selectedScreen === null) {
			this.log('warn', 'Geen scherm geselecteerd')
			return
		} else {
			keys = this.CurrentIsGroup ? this.Groups[this.selectedScreen] || [] : [this.selectedScreen]
		}

		for (const key of keys) {
			const screen = this.screens[key]
			if (!screen) {
				this.log('error', 'Ongeldig scherm geselecteerd')
				continue
			}
			const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/sblines/${screen.Key}/${path}`
			try {
				const res = await fetch(url)
				if (!res.ok) {
					this.log('error', `Fout bij zetten SB regels (${res.status}): ${await res.text()}`)
				}
			} catch (err) {
				this.log('error', `Fout bij zetten SB regels: ${err.message}`)
			}
		}
	}

	setCurrentShow(screenKey, showId) {
		this.currentShow[screenKey] = Number(showId)
		this.checkFeedbacks('screen_show')
	}

	async sendShowToScreen(screenKey, showId) {
		if (screenKey === null) {
			this.log('warn', 'Geen scherm geselecteerd')
			return
		}
		this.restore[screenKey] = showId

		this.log('info', this.CurrentIsGroup ? `Geselecteerde groep: ${screenKey}` : `Geselecteerd scherm: ${screenKey}`)
		if (this.CurrentIsGroup) {

			const screensInGroup = this.Groups[screenKey]
			for (const key of screensInGroup) {
				this.postShowToScreen(key, showId);
			}
		} else {
			this.postShowToScreen(screenKey, showId);
		}
	}
	async postShowToScreen(screenKey, showId, logoId) {
		const screen = this.screens[screenKey]
		if (!screen) {
			this.log('error', 'Ongeldig scherm geselecteerd')
			return
		}

		let url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${showId}`
		if (showId === 1 && logoId) {
			url += `/${logoId}`
		}

		try {
			await fetch(url)
			this.setCurrentShow(screenKey, showId)
			this.checkFeedbacks('current_show')
		} catch (err) {
			this.log('error', `Fout bij verzenden show: ${err.message}`)
		}
	}
	async sendShowLogoToScreen(screenKey, logoId) {
		if (screenKey === null) {
			this.log('warn', 'Geen scherm geselecteerd')
			return
		}

		if (this.CurrentIsGroup) {

			const screensInGroup = this.Groups[screenKey]
			for (const key of screensInGroup) {
				this.postShowToScreen(key, 1, logoId);
			}
		} else {
			this.postShowToScreen(screenKey, 1, logoId);
		}
	}

	async sendShowLogoToAllScreens(logoId) {
		for (const [key, screen] of Object.entries(this.screens)) {
			const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/1/${logoId}`
			try {
				await fetch(url)
				this.setCurrentShow(key, 1)
			} catch (err) {
				this.log('error', `Fout bij verzenden show: ${err.message}`)
			}
		}
	}

	async sendShowToAllScreens(showId, logoId) {
		for (const [key, screen] of Object.entries(this.screens)) {
			let url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${showId}`
			if (showId === 1 && logoId) {
				url += `/${logoId}`
			}
			try {
				await fetch(url)
				this.setCurrentShow(key, showId)
			} catch (err) {
				this.log('error', `Fout bij verzenden show: ${err.message}`)
			}
		}
	}

	async restoreAllScreens() {
		for (const [key, screen] of Object.entries(this.screens)) {
			const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${this.restore[key]}`
			try {
				await fetch(url)
				this.setCurrentShow(key, this.restore[key])
			} catch (err) {
				this.log('error', `Fout bij verzenden show: ${err.message}`)
			}
		}
	}
	async restoreScreen(screenKey) {
		if (screenKey === null) {
			this.log('warn', 'Geen scherm geselecteerd')
			return
		}

		const screen = this.screens[screenKey]
		if (!screen) {
			this.log('error', 'Ongeldig scherm geselecteerd')
			return
		}
		const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${this.restore[screenKey]}`
		try {
			await fetch(url)
			this.setCurrentShow(screenKey, this.restore[screenKey])
		} catch (err) {
			this.log('error', `Fout bij verzenden show: ${err.message}`)
		}
	}

	updatePreset() {
		const presets = {}

		// Screen selection presets
		for (const [key, screen] of Object.entries(this.screens)) {
			const screenKey = ipPortToKey(screen.IP, screen.Key)
			const screenNameVar = `$(${this.label}:screen_name_${screenKey})`

			presets[screenKey] = this.createScreenPreset(
				screen.Name || `Scherm ${key}`,
				screenNameVar,
				key
			)
			presets[`preview_${screenKey}`] = this.createPreviewPreset(screen.Name || `Scherm ${key}`, key)
		}
		for (const [group, screens] of Object.entries(this.Groups)) {
            presets[`group_${group}`] = this.createGroupPreset(group, screens)
			presets[`preview_group_${group}`] = this.createPreviewPreset(`Groep ${group}`, `group:${group}`)
		}
		// Logo presets
		for (const [key, img] of Object.entries(this.logos)) {
			presets[`icon${key}`] = this.createLogoPreset(img, key, 'send_show_logo')
			presets[`iconAll${key}`] = this.createLogoPreset(img, key, 'send_show_logo_all', true)
		}

		// Restore preset
		presets.restore = this.createRestorePreset()
		presets.restore_ALL = this.createRestoreAllPreset()

		// Title presets: make the title active, and make it active + show it on the selection
		for (const [i, title] of this.titles.entries()) {
			presets[`title_${i}`] = this.createTitlePreset(title, false)
			presets[`title_show_${i}`] = this.createTitlePreset(title, true)
		}

		// Show presets
		for (const showOption of this.showOptions) {
			presets[`show${showOption.id}`] = this.createShowPreset(showOption, false)
			presets[`show_ALL_${showOption.id}`] = this.createShowPreset(showOption, true)
		}
        //SBZero preset
		presets[`SBZero`] = this.createSBZeroPreset()
		presets[`ShowReaction`] = this.createShowReactionPreset()
		// SB lines presets
		for (const lines of [4, 6, 8]) {
			presets[`SBLines${lines}`] = this.createSBLinesPreset(lines)
		}
		Object.assign(presets, this.createTalmPresets())
		this.setPresetDefinitions(presets)
	}

	// Preset feedback for buttons that send to the selected screen/group
	noSelectionFeedback() {
		return {
			feedbackId: 'no_selection',
			options: { idlecolor: combineRgb(0x55, 0, 0), errorcolor: combineRgb(255, 0, 0), errortext: 'Geen scherm!' },
		}
	}

	// Talm presets, laid out like the Talm control page
	createTalmPresets() {
		const presets = {}
		const button = (category, name, text, actionId, options, feedbacks = []) => ({
			type: 'button',
			category,
			name,
			style: {
				show_topbar: false,
				text,
				// depth/height values stay on one line, like their text feedback
				size: feedbacks.length > 0 ? oneLineText(text).size : 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
			},
			steps: [{ down: [{ actionId, options }], up: [] }],
			// the warning goes last so its text wins over the depth/height text
			feedbacks: options.target === 'selected' ? [...feedbacks, this.noSelectionFeedback()] : feedbacks,
		})

		for (const minutes of [1, 1.5, 2, 3, 4, 5, 6, 30]) {
			const text = `${Math.floor(minutes)}:${minutes % 1 ? '30' : '00'}`
			presets[`talm_set_${minutes}`] = button('Talm timer', `Timer ${text}`, text, 'talm_set', {
				minutes,
				target: 'selected',
			})
		}
		presets.talm_settime = button('Talm timer', 'Aftellen tot tijdstip', 'tot\n12:00', 'talm_settime', {
			time: '12:00',
			target: 'selected',
		})
		for (const [command, text, category] of [
			['start', 'Start', 'Talm timer'],
			['stop', 'Stop', 'Talm timer'],
			['reset', 'Reset', 'Talm timer'],
			['V', '✓', 'Talm vlag'],
			['X', '✗', 'Talm vlag'],
			['clear', 'Clear', 'Talm vlag'],
		]) {
			presets[`talm_${command}`] = button(category, `Talm ${command}`, text, 'talm_command', {
				command,
				target: 'selected',
			})
		}

		// Depth: --/-/+/++ shift the base, the depth buttons send base + offset and show that value
		for (const [delta, text] of [
			[-5, '--'],
			[-1, '-'],
			[1, '+'],
			[5, '++'],
		]) {
			presets[`talm_depth_base_${delta}`] = button('Talm diepte', `Basis diepte ${text}`, text, 'talm_depth_base', {
				mode: 'add',
				value: delta,
			})
		}
		for (const offset of [-20, -15, -10, -5, 0, 5, 10]) {
			presets[`talm_depth_${offset}`] = button(
				'Talm diepte',
				`Diepte ${offset >= 0 ? '+' : ''}${offset}`,
				`${this.talmDepth(offset)}cm`,
				'talm_depth',
				{ offset, target: 'selected' },
				[{ feedbackId: 'talm_depth_text', options: { useActionOffset: true, offset } }],
			)
		}

		// Height: arrows shift the base, the middle button sends it
		for (const [delta, text] of [
			[-10, '⬇⬇'],
			[-1, '⬇'],
			[1, '⬆'],
			[10, '⬆⬆'],
		]) {
			presets[`talm_height_base_${delta}`] = button('Talm hoogte', `Basis hoogte ${delta}`, text, 'talm_height_base', {
				mode: 'add',
				value: delta,
			})
		}
		presets.talm_height = button(
			'Talm hoogte',
			'Stuur hoogte',
			formatHeight(this.talmBaseHeight),
			'talm_height',
			{ offset: 0, target: 'selected' },
			[{ feedbackId: 'talm_height_text', options: { useActionOffset: true, offset: 0 } }],
		)
		return presets
	}
		createSBZeroPreset() {
			return {
				type: 'button',
				category: 'Other',
				name: `SB 0.0`,
				previewStyle: {
					show_topbar: true,
					bgcolor: this.COLOR_GREEN,
					text: `SB 0.0`,
					size: 'auto',
					color: this.COLOR_WHITE,
				},
				style: {
					show_topbar: false,
					text: `SB 0.0`,
					size: 'auto',
					color: this.COLOR_WHITE,
					bgcolor: this.COLOR_BLACK,
				},
				steps: [
					{
						down: [
							{
								actionId: 'setZero',
							},
						],
						up: [],
					},
				]
			}
	}
	createSBLinesPreset(lines) {
		return {
			type: 'button',
			category: 'Scoreboard',
			name: `SB ${lines} regels`,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: `SB
${lines} regels`,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: `SB
${lines} regels`,
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [
						{
							actionId: 'set_sb_lines',
							options: { lines, title: 'keep', photo: 'keep', photolines: '', all: false },
						},
					],
					up: [],
				},
			],
			feedbacks: [this.noSelectionFeedback()],
		}
	}
	createShowReactionPreset() {
		return {
			type: 'button',
			category: 'Other',
			name: `Show reaction`,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: `Show reaction`,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: `Show reaction`,
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [
						{
							actionId: 'ShowReaction',
						},
					],
					up: [],
				},
			]
		}
	}
		createGroupPreset(groupName, screens) {
		const groupNameVar = `$(${this.label}:group_name_${groupName})`
		
		return {
			type: 'button',
			category: 'Select Group',
			name: `Group ${groupName}`,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: groupName,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: groupName,
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [
						{
							actionId: 'select_group',
							options: { group: groupName },
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'selected_button_highlight',
					options: { nbgcolor: combineRgb(0, 0x60, 0) },
				},
				{
					feedbackId: 'screen_preview',
					options: { target: `group:${groupName}` },
				},
			],
		}
	}
	// Button that only shows the preview of a screen/group: no text and no actions
	createPreviewPreset(name, target) {
		return {
			type: 'button',
			category: 'Preview',
			name: `Preview ${name}`,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: `preview\r\n${name}`,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: '',
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'screen_preview',
					options: { target, textBand: true },
				},
			],
		}
	}
	createScreenPreset(name, screenNameVar, key) {
		return {
			type: 'button',
			category: 'Select Screen',
			name:name,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: screenNameVar,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: screenNameVar,
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [
						{
							actionId: 'select_screen',
							options: { screen: parseInt(key) },
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'selected_button_highlight',
					options: { nbgcolor: combineRgb(0, 0x60, 0) },
				},
				{
					feedbackId: 'screen_preview',
					options: { target: key },
				},
			],
		}
	}

	createLogoPreset(img, key, actionId, isAll = false) {
		return {
			type: 'button',
			category: isAll ? 'Show icon all' : 'Show icon',
			name: `showicon${img}`,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: `showicon\r\n${img}`,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: img,
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [
						{
							actionId: 'send_show_logo',
							options: { logo: key },
						},
					],
					up: [],
				},
			],
			feedbacks: [this.noSelectionFeedback()],
		}
	}

	createTitlePreset(title, show) {
		return {
			type: 'button',
			category: show ? 'Title + show' : 'Title',
			name: show ? `Titel ${title} + show` : `Titel ${title}`,
			style: {
				show_topbar: false,
				text: title,
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
			},
			steps: [
				{
					down: [{ actionId: 'set_title', options: { title, show } }],
					up: [],
				},
			],
			feedbacks: [
				{ feedbackId: 'title_active', options: { title }, style: { bgcolor: combineRgb(0, 0, 0x90) } },
				...(show ? [this.noSelectionFeedback()] : []),
			],
		}
	}

	createRestoreAllPreset() {
		return {
			type: 'button',
			category: 'Show all',
			name: 'restore',
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: 'restore\r\nall',
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: 'restore\r\nall',
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [{ actionId: 'restore_screens' }],
					up: [],
				},
			],
		}
	}
	createRestorePreset() {
		return {
			type: 'button',
			category: 'Show',
			name: 'restore',
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: 'restore',
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text: 'restore',
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [{ actionId: 'restore_screen' }],
					up: [],
				},
			],
			feedbacks: [this.noSelectionFeedback()],
		}
	}

	createShowPreset(showOption, isAll) {
		const category = isAll ? 'Show all' : 'Show'
		const name = isAll ? `show${showOption.label} all` : `show${showOption.label}`
		const text = isAll ? `${showOption.label} all` : showOption.label

		return {
			type: 'button',
			category,
			name,
			previewStyle: {
				show_topbar: true,
				bgcolor: this.COLOR_GREEN,
				text: isAll ? `all\r\n${showOption.label}` : `show\r\n${showOption.label}`,
				size: 'auto',
				color: this.COLOR_WHITE,
			},
			style: {
				show_topbar: false,
				text,
				size: 'auto',
				color: this.COLOR_WHITE,
				bgcolor: this.COLOR_BLACK,
			},
			steps: [
				{
					down: [
						{
							actionId: isAll ? 'send_show_all' : 'send_show',
							options: { show: showOption.id },
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'current_show',
					options: { show: showOption.id, nbgcolor: combineRgb(0, 0, 0x90) },
				},
				...(isAll ? [] : [this.noSelectionFeedback()]),
			],
		}
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'serverIp',
				label: 'IP Address',
				width: '32',
				default: '192.168.0.100',
			},
			{
				type: 'textinput',
				id: 'serverPort',
				label: 'poort',
				default: '8001',
				width: '10',
			},
			{
				type: 'checkbox',
				id: 'enablePreviews',
				label: 'Previews tonen op scherm/groep knoppen',
				width: 6,
				default: false,
			},
			{
				type: 'number',
				id: 'previewInterval',
				label: 'Preview interval (seconden, 0 = alleen bij knopdruk)',
				width: 6,
				min: 0,
				max: 60,
				default: 2,
				isVisible: (options) => !!options.enablePreviews,
			},
			{
				type: 'number',
				id: 'talmDepth',
				label: 'Talm standaard diepte (cm)',
				width: 6,
				min: 0,
				max: 1000,
				default: 60,
			},
			{
				type: 'number',
				id: 'talmHeight',
				label: 'Talm standaard hoogte (cm)',
				width: 6,
				min: 0,
				max: 1000,
				default: 200,
			},
		]
	}

	async configUpdated(config) {
		this.serverIp = config.serverIp
		this.serverPort = config.serverPort
		// A changed default puts the base back on the new default
		if (parseInt(config.talmDepth) !== parseInt(this.config.talmDepth)) this.talmBaseDepth = parseInt(config.talmDepth) || 60
		if (parseInt(config.talmHeight) !== parseInt(this.config.talmHeight))
			this.talmBaseHeight = parseInt(config.talmHeight) || 200
		this.config = config
		this.talmBaseChanged()
		this.fetchScreens()
		this.fetchLogo()
		this.fetchTitles()
		this.startPolling()
		this.startPreviewPolling()
	}

	async destroy() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
		if (this.previewTimer) {
			clearInterval(this.previewTimer)
			this.previewTimer = null
		}
		clearTimeout(this.previewFollowUpTimer)
		clearTimeout(this.previewInitTimer)
		for (const timer of Object.values(this.noSelectionFlash)) clearTimeout(timer)
		this.noSelectionFlash = {}
	}
}

runEntrypoint(LEDScreenModule)

// Scales an RGBA image to fit width x height (keeping aspect ratio, centred, transparent bands) by area averaging
function scaleToFit(src, width, height) {
	const out = Buffer.alloc(width * height * 4)
	const scale = Math.min(width / src.width, height / src.height)
	const w = Math.max(1, Math.round(src.width * scale))
	const h = Math.max(1, Math.round(src.height * scale))
	const offX = Math.floor((width - w) / 2)
	const offY = Math.floor((height - h) / 2)
	for (let y = 0; y < h; y++) {
		const sy0 = Math.floor((y * src.height) / h)
		const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / h))
		for (let x = 0; x < w; x++) {
			const sx0 = Math.floor((x * src.width) / w)
			const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / w))
			let r = 0
			let g = 0
			let b = 0
			let a = 0
			for (let sy = sy0; sy < sy1; sy++) {
				for (let sx = sx0; sx < sx1; sx++) {
					const i = (sy * src.width + sx) * 4
					r += src.data[i]
					g += src.data[i + 1]
					b += src.data[i + 2]
					a += src.data[i + 3]
				}
			}
			const n = (sy1 - sy0) * (sx1 - sx0)
			const o = ((offY + y) * width + offX + x) * 4
			out[o] = r / n
			out[o + 1] = g / n
			out[o + 2] = b / n
			out[o + 3] = a / n
		}
	}
	return out
}

// Darkens the bottom part of an RGBA image (in place) with a semi-transparent black band to put text on
function addTextBand(buf, width, height, bandFraction = 0.35, opacity = 0.6) {
	const bandTop = height - Math.round(height * bandFraction)
	for (let y = bandTop; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4
			const a = buf[o + 3] / 255
			const outA = opacity + a * (1 - opacity)
			const k = (a * (1 - opacity)) / outA
			buf[o] *= k
			buf[o + 1] *= k
			buf[o + 2] *= k
			buf[o + 3] = Math.round(outA * 255)
		}
	}
	return buf
}

// Button text with a fixed font size small enough to keep it on one line: with size 'auto' Companion
// prefers a bigger font over two lines and splits values like 2.05m into "2.05" and "m"
function oneLineText(text) {
	return { text, size: text.length <= 6 ? 18 : 14 }
}

// Height in cm as shown on the Talm control page, e.g. 200 -> 2.00m
function formatHeight(cm) {
	const sign = cm < 0 ? '-' : ''
	const abs = Math.abs(cm)
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}m`
}

function ipPortToKey(ip, key) {
	if (ip == null) {
		ip = '127.0.0.1'
	}
	const parts = ip.split('.').map(Number)
	if (parts.length !== 4 || parts.some(n => n < 0 || n > 255 || Number.isNaN(n))) {
		throw new Error('Invalid IPv4 address')
	}
	const ipInt = ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]
	return ipInt * 65536 + key
}