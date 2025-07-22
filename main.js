const { InstanceBase, runEntrypoint } = require('@companion-module/base')
const dgram = require('dgram')
const fetch = require('node-fetch')

class LEDScreenModule extends InstanceBase {
  async init(config) {
    this.config = config
    this.selectedScreen = null
    this.serverIp = null
    this.serverPort = null
    this.screens = {}
    this.showOptions = [
      { id: 0, label: 'Anu' },
      { id: 1, label: 'Logo' },
      { id: 2, label: 'Dia' },
      { id: 3, label: 'Talm' },
      { id: 4, label: 'Hidden' },
      { id: 5, label: 'FTB' },
      { id: 6, label: 'DEBUG' }
    ]

    this.initUDPListener()
    this.updateActions()
  }

  initUDPListener() {
    if (!this.config.serverIp || this.config.serverIp.length === 0) {
        const socket = dgram.createSocket('udp4')
        socket.bind(8050)

        socket.on('message', (msg, rinfo) => {
        const message = msg.toString()
        if (message.startsWith('LEDScreen_peer;')) {
            const port = message.split(';')[1]
            this.serverIp = rinfo.address
            this.serverPort = port
            this.log('info', `Server gevonden op ${this.serverIp}:${this.serverPort}`)
            this.fetchScreens()
			socket.destroy();
        }
        })
    }else{
        this.serverIp = this.config.serverIp;
        this.serverPort = this.config.serverPort;
    }
  }

  async fetchScreens() {
    try {
      const url = `http://${this.serverIp}:${this.serverPort}/screens/true/`
      const res = await fetch(url)
      const data = await res.json()
      this.screens = data
      this.log('info', `${Object.keys(data).length} schermen geladen`)
      this.updateActions()
    } catch (err) {
      this.log('error', 'Kan schermen niet laden: ' + err.message)
    }
  }

  updateActions() {
    const screenChoices = Object.entries(this.screens).map(([key, screen]) => ({
      id: parseInt(key),
      label: screen.Name || `Scherm ${key}`
    }))

    this.setActionDefinitions({
      select_screen: {
        name: 'Selecteer scherm',
        options: [
          {
            type: 'dropdown',
            id: 'screen',
            label: 'Kies scherm',
            default: 0,
            choices: screenChoices
          }
        ],
        callback: (event) => {
          this.selectedScreen = parseInt(event.options.screen)
          this.log('info', `Geselecteerd scherm: ${this.selectedScreen}`)
        }
      },

      send_show: {
        name: 'Stuur show naar geselecteerd scherm',
        options: [
          {
            type: 'dropdown',
            id: 'show',
            label: 'Show type',
            default: 0,
            choices: this.showOptions
          }
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

          const url = `http://${screen.IP||this.serverIp}:${screen.Port||this.serverPort}/screen/${screen.Key}/${event.options.show}`

          try {
            await fetch(url)
            this.log('info', `Show ${event.options.show} verzonden naar ${screen.Name}`)
          } catch (err) {
            this.log('error', `Fout bij verzenden show: ${err.message}`)
          }
        }
      }
    })
  }

  getConfigFields() {
    return [{
        type: 'textinput',
        id: 'serverIp',
        label: 'IP Address',
        default: '192.168.0.100'
      },{
        type: 'textinput',
        id: 'serverPort',
        label: 'poort',
        default: '8001'
      }]
  }

  async configUpdated(config) {
    this.config = config;
	this.fetchScreens()
  }

  async destroy() {}
}

runEntrypoint(LEDScreenModule)
