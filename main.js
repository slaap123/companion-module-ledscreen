const { InstanceBase, runEntrypoint, InstanceStatus  } = require('@companion-module/base')
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
    
    this.updateVariables();
    this.updateFeedbacks();
  }

  initUDPListener() {
    if (!this.config.serverIp || this.config.serverIp.length === 0) {
        
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
                this.log('error', 'Kan schermen niet laden: ' + err.message)
            }
        }
    }else{
        this.serverIp = this.config.serverIp;
        this.serverPort = this.config.serverPort;
        this.log('info', `Server gevonden via config ${this.serverIp}:${this.serverPort}`)
        this.fetchScreens()
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
      this.updateStatus(InstanceStatus.Ok)
    } catch (err) {
      this.log('error', 'Kan schermen niet laden: ' + err.message)
    }
  }
updateVariables() {
    const variables = [
      { variableId: 'last_selected_screen_button_id', name: 'Laatst Geselecteerd Scherm Knop ID' },
    ];

    this.set
    this.setVariableDefinitions(variables);

    // Initialiseer de waarden
    this.setVariableValues({
     last_selected_screen_button_id: null,
    });
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
          const currentButtonId = feedback.controlId;
          const lastSelectedButtonId = this.getVariableValue('last_selected_screen_button_id');
            this.log('info', `${currentButtonId} == ${lastSelectedButtonId}`)
          // Vergelijk de ID's
          if (currentButtonId && lastSelectedButtonId && currentButtonId === lastSelectedButtonId) {
            return {
              bgcolor: this.COLOR_GREEN, // Stel de achtergrondkleur in op geel
              color: this.COLOR_BLACK, // Optioneel: pas de tekstkleur aan voor contrast
            };
          }
          return false; // Geen highlight
        },
      },
    };
    this.setFeedbackDefinitions(feedbacks);
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
            if (this.getVariableValue('last_selected_screen_button_id') !== null) {
              this.checkFeedbacks('selected_button_highlight'); // Controleer de feedback om de highlight te verwijderen
          }
          this.selectedScreen = parseInt(event.options.screen)
          this.log('info', `Geselecteerd scherm: ${this.selectedScreen}`)
          this.setVariableValues({
            last_selected_screen_button_id: this.lastCommand ? this.lastCommand.button : null,
          });
          this.checkFeedbacks('selected_button_highlight');
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
