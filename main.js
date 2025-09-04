const { InstanceBase, runEntrypoint, InstanceStatus } = require('@companion-module/base')
//const dgram = require('dgram')
//const fetch = require('node-fetch')

class LEDScreenModule extends InstanceBase {
	async init(config) {
		this.config = config
		this.selectedScreen = null
		this.serverIp = null
		this.serverPort = null
		this.screens = {}
		this.Restore = {}
		this.Logos = {}
		this.showOptions = [
			{ id: 0, label: 'Anu' },
			{ id: 1, label: 'Logo' },
			{ id: 2, label: 'Dia' },
			{ id: 3, label: 'Talm' },
			{ id: 4, label: 'Hidden' },
			{ id: 5, label: 'SB' },
			{ id: 6, label: 'TOD' },
			{ id: 7, label: 'FTB' },
			{ id: 8, label: 'DEBUG' },
		]

		this.initUDPListener()
		this.updateActions()

		this.updateVariables()
		this.updateFeedbacks()
	}

	initUDPListener() {
		/*if (!this.config.serverIp || this.config.serverIp.length === 0) {
        
        try {
            const socket = dgram.createSocket('udp4')
            socket.bind(8051)

            socket.on('message', (msg, rinfo) => {
            const message = msg.toString()
            if (message.startsWith('LEDScreen_peer;')) {
                const port = message.split(';')[1]
                this.serverIp = rinfo.address
                this.serverPort = port
                this.log('info', `Server gevonden op ${this.serverIp}:${this.serverPort}`)
                this.fetchScreens()
			    socket.close();
            }
            })
        } catch (err) {
            if(err.message=="bind EADDRINUSE 0.0.0.0:8050"){
                    this.serverIp = "127.0.0.1";
                    this.serverPort = "8001";
                    this.log('info', `Server ${this.serverIp}:${this.serverPort}`)
                    this.fetchScreens()
            }else{
                this.log('error', 'error on udp: ' + err.message)
            }
        }
    }else{*/
		this.serverIp = this.config.serverIp
		this.serverPort = this.config.serverPort
		this.fetchScreens()
		this.fetchLogo();
		//}
	}

	async fetchScreens() {
		try {
			const url = `http://${this.serverIp}:${this.serverPort}/screens/true/`
			const res = await fetch(url)
			const data = await res.json()
			this.screens = data
			this.log('info', `${Object.keys(data).length} schermen geladen`)

			for (const [key, screen] of Object.entries(this.screens)) {
				this.Restore[key] = screen.Show;
        this.log('info',  `default ${screen.Show}`)
			}
			this.updateActions()
			this.updatePreset()
			this.updateStatus(InstanceStatus.Ok)
		} catch (err) {
			this.log('error', 'Kan schermen niet laden: ' + err.message)
		}
	}
	async fetchLogo() {
		try {
			const url = `http://${this.serverIp}:${this.serverPort}/images/`
			const res = await fetch(url)
			const data = await res.json()
			this.log('info', `${Object.keys(data).length} logos geladen`)
			this.Logos=data;
			this.updateActions()
		} catch (err) {
			this.log('error', 'Kan logos niet laden: ' + err.message)
		}
	}
	updateVariables() {
		const variables = [{ variableId: 'last_selected_screen_button_id', name: 'Laatst Geselecteerd Scherm Knop ID' }]

		this.set
		this.setVariableDefinitions(variables)

		// Initialiseer de waarden
		this.setVariableValues({
			last_selected_screen_button_id: null,
		})
	}
	updateFeedbacks() {
		const feedbacks = {
			selected_button_highlight: {
				type: 'boolean', // Of 'advanced' als je meer styling wilt
				name: 'Highlight laatst geselecteerde schermknop',
				description: 'Maakt de knop geel als deze de laatst geselecteerde schermknop was.',
				options: [], // Geen opties nodig, we controleren de knop-ID
				callback: (feedback) => {
					// De ID van de knop waarop deze feedback is toegepast
					const currentButtonId = feedback.controlId
					const lastSelectedButtonId = this.getVariableValue('last_selected_screen_button_id')
					// Vergelijk de ID's
					if (currentButtonId && lastSelectedButtonId && currentButtonId === lastSelectedButtonId) {
						//this.log('info', ` set backgroudn:${currentButtonId} == ${lastSelectedButtonId}`)
						/*return {
							bgcolor: this.COLOR_GREEN, // Stel de achtergrondkleur in op geel
							color: this.COLOR_BLACK, // Optioneel: pas de tekstkleur aan voor contrast
						}*/
						return true
					}
					return false // Geen highlight
				},
			},
			current_show: {
				ype: 'advanced', // Of 'advanced' als je meer styling wilt
				name: 'Highlight huidige show',
				description: 'Maakt de knop geel als deze de laatst geselecteerde schermknop was.',
				options: [
					{
						type: 'dropdown',
						id: 'show',
						label: 'Show type',
						default: 0,
						choices: this.showOptions,
					},
					{
						type: 'colorpicker',
						label: 'New Background Color',
						id: 'bgcolor',
						default: this.COLOR_GREEN,
					},
				], // Geen opties nodig, we controleren de knop-ID
				callback: (feedback) => {
					
					if (feedback.options.show == this.Restore[this.selectedScreen]) {
						return {
							bgcolor: feedback.options.bgcolor,
						}
					}
					return {} // Geen highlight
				},
			},
		}
		this.setFeedbackDefinitions(feedbacks)
	}
	updateActions() {
		const screenChoices = Object.entries(this.screens).map(([key, screen]) => ({
			id: parseInt(key),
			label: screen.Name || `Scherm ${key}`,
		}))
		
		const logoChoices = Object.entries(this.Logos).map(([key, logo]) => ({
			id: parseInt(key),
			label: logo,
		}))

		this.setActionDefinitions({

			setZero: {
				name: 'set SB to 0.0',
				callback: (event) => {
					const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/SBZero`
					
					try {
						await fetch(url)
						//this.log('info', `Show ${event.options.show} verzonden naar ${screen.Name}`)
					} catch (err) {
						this.log('error', `Fout bij verzenden show: ${err.message}`)
					}
				},
			}, select_screen: {
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
					if (this.getVariableValue('last_selected_screen_button_id') !== null) {
						this.checkFeedbacks('selected_button_highlight') // Controleer de feedback om de highlight te verwijderen
					}
					this.selectedScreen = parseInt(event.options.screen)
					this.setVariableValues({
						last_selected_screen_button_id: event.controlId,
					})
					this.checkFeedbacks('selected_button_highlight')
					this.checkFeedbacks('current_show')
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
					if (this.selectedScreen === null) {
						this.log('warn', 'Geen scherm geselecteerd')
						return
					}

					const screen = this.screens[this.selectedScreen]
					if (!screen) {
						this.log('error', 'Ongeldig scherm geselecteerd')
						return
					}

					this.Restore[this.selectedScreen] = event.options.show
					//this.log('info', `set restore to ${this.Restore[this.selectedScreen]} voor naar ${this.selectedScreen}`)
					const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${event.options.show}`

					this.checkFeedbacks('current_show')
					try {
						await fetch(url)
						//this.log('info', `Show ${event.options.show} verzonden naar ${screen.Name}`)
					} catch (err) {
						this.log('error', `Fout bij verzenden show: ${err.message}`)
					}
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
					if (this.selectedScreen === null) {
						this.log('warn', 'Geen scherm geselecteerd')
						return
					}

					const screen = this.screens[this.selectedScreen]
					if (!screen) {
						this.log('error', 'Ongeldig scherm geselecteerd')
						return
					}

					this.Restore[this.selectedScreen] = event.options.show
					//this.log('info', `set restore to ${this.Restore[this.selectedScreen]} voor naar ${this.selectedScreen}`)
					const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/1/${event.options.logo}`

					this.checkFeedbacks('current_show')
					try {
						await fetch(url)
						//this.log('info', `Show ${event.options.show} verzonden naar ${screen.Name}`)
					} catch (err) {
						this.log('error', `Fout bij verzenden show: ${err.message}`)
					}
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
					for (const [key, screen] of Object.entries(this.screens)) {
						var url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/1/${event.options.logo}`
						if(event.options.show==1&&event.options.logo){
							url+="/"+event.options.logo;
						}
						try {
							await fetch(url)
							//this.log('info', `Show ${event.options.show} verzonden naar ${screen.Name}`)
						} catch (err) {
							this.log('error', `Fout bij verzenden show: ${err.message}`)
						}
					}
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
					},{
						type: 'dropdown',
						id: 'logo',
						label: 'logo',
						choices: logoChoices,
					},
				],
				callback: async (event) => {
					for (const [key, screen] of Object.entries(this.screens)) {
						var url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${event.options.show}`
						if(event.options.show==1&&event.options.logo){
							url+="/"+event.options.logo;
						}
						try {
							await fetch(url)
							//this.log('info', `Show ${event.options.show} verzonden naar ${screen.Name}`)
						} catch (err) {
							this.log('error', `Fout bij verzenden show: ${err.message}`)
						}
					}
				},
			},
			restore_screens: {
				name: 'Stuur restore',
				callback: async (event) => {
					for (const [key, screen] of Object.entries(this.screens)) {
						const url = `http://${screen.IP || this.serverIp}:${screen.Port || this.serverPort}/screen/${screen.Key}/${this.Restore[key]}`

						try {
							await fetch(url)
							//this.log('info', `restore ${this.Restore[key]} verzonden naar ${screen.Name}`)
						} catch (err) {
							this.log('error', `Fout bij verzenden show: ${err.message}`)
						}
					}
				},
			},
		})
	}
	updatePreset() {
		var presets = {}
		for (const [key, screen] of Object.entries(this.screens)) {
			presets[screen.Name || `Scherm ${key}`] = {
				type: 'button',
				category: 'Select Screen',
				name: screen.Name || `Scherm ${key}`,
				previewStyle: {
					show_topbar: true,
					bgcolor: this.COLOR_GREEN,
					text: `Scherm`,
					size: 'auto',
					color: this.COLOR_WHITE,
				},
				style: {
					show_topbar: false,
					// This is the minimal set of style properties you must define
					text: screen.Name || `Scherm ${key}`,
					size: 'auto',
					color: this.COLOR_WHITE,
					bgcolor: this.COLOR_BLACK,
				},
				steps: [
					{
						down: [
							{
								actionId: 'select_screen',
								options: {
									// options values to use
									screen: parseInt(key),
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'selected_button_highlight',
						style: {
							bgcolor: this.COLOR_YELLOW,
						},
					},
				],
			}
		}
		for (const showE of this.showOptions) {
			presets[`show${showE.id}`] = {
				type: 'button',
				category: 'Show',
				name: `show${showE.label}`,
				previewStyle: {
					show_topbar: true,
					bgcolor: this.COLOR_GREEN,
					text: `show`,
					size: 'auto',
					color: this.COLOR_WHITE,
				},
				style: {
					show_topbar: false,
					// This is the minimal set of style properties you must define
					text: `${showE.label}`,
					size: 'auto',
					color: this.COLOR_WHITE,
					bgcolor: this.COLOR_BLACK,
				},
				steps: [
					{
						down: [
							{
								actionId: 'send_show',
								options: {
									// options values to use
									show: showE.id,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'current_show',
						options: {
							// options values to use
							show: showE.id,
              bgcolor: this.COLOR_GREEN,
						},
					},
				],
			}
			presets[`show_ALL_${showE.id}`] = {
				type: 'button',
				category: 'Show all',
				name: `show${showE.label} all`,
				text: `show all`,
				previewStyle: {
					show_topbar: true,
					bgcolor: this.COLOR_GREEN,
					text: `show all`,
					size: 'auto',
					color: this.COLOR_WHITE,
				},
				style: {
					show_topbar: false,
					// This is the minimal set of style properties you must define
					text: `${showE.label} all`,
					size: 'auto',
					color: this.COLOR_WHITE,
					bgcolor: this.COLOR_BLACK,
				},
				steps: [
					{
						name: `show${showE.label}all`,
						down: [
							{
								actionId: 'send_show_all',
								options: {
									// options values to use
									show: showE.id,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		}

		this.setPresetDefinitions(presets)
	}
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'serverIp',
				label: 'IP Address',
				default: '192.168.0.100',
			},
			{
				type: 'textinput',
				id: 'serverPort',
				label: 'poort',
				default: '8001',
			},
		]
	}

	async configUpdated(config) {
		this.config = config
		this.fetchScreens()
		this.fetchLogo();
	}

	async destroy() {}
}

runEntrypoint(LEDScreenModule)
