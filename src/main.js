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
		this.logos = {}
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

		const interval = Math.max(0.5, parseFloat(this.config.previewInterval) || 2) * 1000
		this.previewTimer = setInterval(() => this.fetchPreviews(interval), interval)
		this.fetchPreviews(interval)
	}

	// A preview target is a screen key, or 'group:<name>' which shows the first screen of that group
	previewTargetToScreenKey(target) {
		if (typeof target === 'string' && target.startsWith('group:')) {
			return (this.Groups[target.substring(6)] || [])[0]
		}
		return target
	}

	async fetchPreviews(timeout) {
		if (this.previewsInFlight) return
		this.previewsInFlight = true
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
	}

	startPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
		}

		this.pollTimer = setInterval(() => {
			this.log('info', 'Updating data')
			this.fetchScreens()
			this.fetchLogo()
		}, 60000)
	}

	initUDPListener() {
		this.serverIp = this.config.serverIp
		this.serverPort = this.config.serverPort
		this.fetchScreens()
		this.fetchLogo()
	}

	async fetchScreens() {
		try {
			const url = `http://${this.serverIp}:${this.serverPort}/screens/true/`
			const res = await fetch(url)
			const data = await res.json()
			const nscreens = {}

			this.log('info', `${Object.keys(data).length} schermen geladen`)
			for (const [, screen] of Object.entries(data)) {
				const key = ipPortToKey(screen.IP, screen.Key)
                if (!this.restore[key]) {
					this.restore[key] = screen.Show;
                }
				nscreens[ipPortToKey(screen.IP, screen.Key)] = screen
				for (const group of screen.SendGroups) {
					if(group=="Default") continue;
					if (!this.Groups[group]) {
						this.Groups[group] = [];
					}
					this.Groups[group].push(key);
				}
			}

			this.log('info', `Groups: ${JSON.stringify(this.Groups)}`)
			this.screens = nscreens
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

	updateVariables() {
		this.setVariableDefinitions(this.buildVariableDefinitions())
		this.setVariableValues({
			last_selected_screen_button_id: null,
			selected_Screen_key: null,
		})
	}

	buildVariableDefinitions() {
		const variables = [
			{ variableId: 'last_selected_screen_button_id', name: 'Laatst Geselecteerd Scherm Knop ID' },
			{ variableId: 'selected_Screen_key', name: 'Laatst Geselecteerd Scherm key' },
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
		const previewChoices = [
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
						default: combineRgb(255, 0, 0),
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
						default: combineRgb(0, 0, 255),
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
					default: previewChoices[0]?.id ?? '',
					choices: previewChoices,
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
				const sizeKey = `${width}x${height}`
				preview.scaled[sizeKey] ??= addTextBand(scaleToFit(preview, width, height), width, height)
				return {
					imageBuffer: preview.scaled[sizeKey],
					imageBufferEncoding: { pixelFormat: 'RGBA' },
					imageBufferPosition: { x: 0, y: 0, width, height },
					// Text goes on the dark band at the bottom so it stays readable over the preview
					alignment: 'center:bottom',
				}
			},
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

		const keepOnOffChoices = [
			{ id: 'keep', label: 'Niet wijzigen' },
			{ id: '1', label: 'Aan' },
			{ id: '0', label: 'Uit' },
		]

		this.setActionDefinitions({
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
					this.checkFeedbacks('selected_button_highlight', 'current_show')
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
					this.checkFeedbacks('selected_button_highlight', 'current_show')
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
				callback: async () => {
					await this.restoreScreen(this.selectedScreen)
				},
			},
			restore_screens: {
				name: 'Stuur restore',
				callback: async () => {
					await this.restoreAllScreens()
				},
			},
		})
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
		for (const [, screen] of Object.entries(this.screens)) {
			const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/1/${logoId}`
			try {
				await fetch(url)
			} catch (err) {
				this.log('error', `Fout bij verzenden show: ${err.message}`)
			}
		}
	}

	async sendShowToAllScreens(showId, logoId) {
		for (const [, screen] of Object.entries(this.screens)) {
			let url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${showId}`
			if (showId === 1 && logoId) {
				url += `/${logoId}`
			}
			try {
				await fetch(url)
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
		}
		for (const [group, screens] of Object.entries(this.Groups)) {
            presets[`group_${group}`] = this.createGroupPreset(group, screens)
		}
		// Logo presets
		for (const [key, img] of Object.entries(this.logos)) {
			presets[`icon${key}`] = this.createLogoPreset(img, key, 'send_show_logo')
			presets[`iconAll${key}`] = this.createLogoPreset(img, key, 'send_show_logo_all', true)
		}

		// Restore preset
		presets.restore = this.createRestorePreset()
		presets.restore_ALL = this.createRestoreAllPreset()

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
		this.setPresetDefinitions(presets)
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
					options: { nbgcolor: combineRgb(0xCC, 0xCC, 0x00) },
				},
				{
					feedbackId: 'screen_preview',
					options: { target: `group:${groupName}` },
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
					options: { nbgcolor: combineRgb(0xCC, 0xCC, 0x00) },
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
					options: { show: showOption.id, nbgcolor: combineRgb(0xCC,0x00, 0xCC) },
				},
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
				label: 'Preview interval (seconden)',
				width: 6,
				min: 0.5,
				max: 60,
				default: 2,
				isVisible: (options) => !!options.enablePreviews,
			},
		]
	}

	async configUpdated(config) {
		this.serverIp = config.serverIp
		this.serverPort = config.serverPort
		this.config = config
		this.fetchScreens()
		this.fetchLogo()
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