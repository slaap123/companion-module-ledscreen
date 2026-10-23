## LED Screen

Bedien de LedScreen schermen vanuit Companion: shows wisselen, logo's tonen, het scoreboard instellen, de Talm (timer, vlag, diepte en hoogte) bedienen en een preview van de schermen op de knoppen tonen.

De module haalt de schermen, groepen en logo's zelf op bij de LedScreen server en ververst die elke minuut. Nieuwe schermen of logo's verschijnen daarna vanzelf in de acties en presets.

### Instellingen

| Instelling                             | Uitleg                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| IP Address / poort                     | Adres van de LedScreen server (standaard poort 8001).                                                                                     |
| Previews tonen op scherm/groep knoppen | Haalt een preview van de schermen op voor de _Preview_ feedback.                                                                          |
| Preview interval                       | Om de hoeveel seconden de previews ververst worden. **0** = geen vaste verversing, alleen bij het indrukken van een knop van deze module. |
| Talm standaard diepte (cm)             | Startwaarde van de basis diepte (standaard 60 cm).                                                                                        |
| Talm standaard hoogte (cm)             | Startwaarde van de basis hoogte (standaard 200 cm).                                                                                       |

### Werkwijze: eerst selecteren, dan sturen

De meeste knoppen sturen naar het **geselecteerde scherm of de geselecteerde groep**. Druk dus eerst op een scherm- of groepknop (_Select Screen_ / _Select Group_ presets) en daarna op de show-, logo- of Talm-knop.

- Het geselecteerde scherm of de groep kleurt **donkergroen**.
- De huidige show van het geselecteerde scherm kleurt **donkerblauw**.
- Is er nog niets geselecteerd, dan zijn de knoppen die naar de selectie sturen **donkerrood**. Druk je er toch op, dan wordt er niets verstuurd en knippert de knop 2 seconden rood met **"Geen scherm!"**.

Na elke knopdruk worden de previews meteen ververst, en een seconde later nog een keer.

### Acties

**Selectie en shows**

- **Selecteer scherm** / **Selecteer groep**: kiest waar de volgende knoppen naartoe sturen.
- **Stuur show naar geselecteerd scherm**: Anu, Logo, Dia, Talm, Hidden, SB, IsoLynx, TOD, Title, Ruler, NDI, FTB of DEBUG.
- **Stuur show naar all**: dezelfde show op alle schermen (bij Logo ook met een logo).
- **Stuur show logo+ het logo naar geselecteerd scherm / alle schermen**: zet de Logo show met het gekozen logo.
- **Stuur restore naar geselecteerd scherm** / **Stuur restore**: zet de vorige show terug.

**Titel**

- **Zet titel (op naam)**: maakt de opgeslagen titel met die naam de actieve titel, net als _Publish_ op het Title tabblad van LedScreen. Schermen die de Title show tonen wisselen meteen. Kies de naam uit de lijst of typ hem (variabelen mogen). Zet _Ook de Title show op het geselecteerde scherm/groep zetten_ aan om het geselecteerde scherm ook meteen naar de Title show te zetten.
- De titel wordt op elke LedScreen computer gezet waar een scherm van deze module op draait. Dit werkt alleen met een LedScreen versie die titels kiezen ondersteunt (`/settitle`).

**Scoreboard**

- **Zet aantal SB regels**: aantal atleetregels, titel en foto aan/uit, fotoregels. Naar de selectie of naar alle schermen.
- **set SB to 0.0** en **show reaction times**: naar alle schermen.

**Talm**

Elke Talm actie heeft een optie **Scherm of groep**: _Geselecteerd scherm/groep_ (standaard) of een vast scherm of een vaste groep.

- **Talm: zet timer**: zet de timer op een aantal minuten (bijv. 1,5 = 1:30).
- **Talm: aftellen tot tijdstip**: telt af tot een tijd (UU:MM, variabelen mogen).
- **Talm: commando**: Start, Stop, Reset, Geldig (✓), Ongeldig (✗) of Clear. Start neemt de laatst gekozen timer mee, net als de Talm control pagina.
- **Talm: stuur diepte (basis + offset)**: stuurt de basis diepte plus de offset. Basis 60 en offset -5 stuurt 55 cm.
- **Talm: wijzig basis diepte**: verhoogt/verlaagt de basis (bijv. -5 of +5) of zet hem op een waarde. Stuurt zelf niets naar het scherm.
- **Talm: stuur hoogte (basis + offset)** en **Talm: wijzig basis hoogte**: hetzelfde voor de hoogte.

De basis diepte en hoogte gelden voor alle schermen samen.

### Feedbacks

- **Highlight laatst geselecteerde schermknop**: kleurt de laatst ingedrukte scherm/groepknop (standaard donkergroen).
- **Highlight huidige show**: kleurt de show knop als dat de show van het geselecteerde scherm is (standaard donkerblauw).
- **Show actief op scherm/groep**: kleurt de knop als het gekozen scherm (of alle schermen van de groep) de gekozen show toont.
- **Preview van scherm/groep**: toont de inhoud van het scherm (of het eerste scherm van de groep) als achtergrond, optioneel met een donkere balk voor de tekst. Werkt alleen als previews aan staan.
- **Titel actief**: kleurt de knop als de gekozen titel de actieve titel is (standaard donkerblauw).
- **Waarschuwing: geen scherm geselecteerd**: kleurt de knop als er niets geselecteerd is en knippert een foutmelding bij indrukken. Kleuren en tekst zijn in te stellen.
- **Talm: diepte als knoptekst** / **Talm: hoogte als knoptekst**: zet de knoptekst op basis + offset (bijv. `55cm` of `2.10m`). De tekst krijgt een vaste lettergrootte zodat de waarde op één regel blijft. Standaard volgt de tekst automatisch de offset van de stuur actie op dezelfde knop, dus de knop toont precies wat hij verstuurt. Zet _Offset van de stuur-actie op deze knop gebruiken_ uit om zelf een offset in te vullen.

Knoppen die je al geplaatst had krijgen nieuwe feedbacks of kleuren niet vanzelf: voeg ze toe of plaats de knop opnieuw vanuit de presets.

### Variabelen

| Variabele                                     | Inhoud                                             |
| --------------------------------------------- | -------------------------------------------------- |
| `$(ledscreen:selected_Screen_key)`            | Key van het geselecteerde scherm, of de groepsnaam |
| `$(ledscreen:last_selected_screen_button_id)` | Knop die het laatst een selectie maakte            |
| `$(ledscreen:screen_name_<key>)`              | Naam van elk scherm                                |
| `$(ledscreen:talm_base_depth)`                | Huidige basis diepte in cm                         |
| `$(ledscreen:talm_base_height)`               | Huidige basis hoogte in cm                         |
| `$(ledscreen:talm_base_height_m)`             | Huidige basis hoogte als `2.00m`                   |
| `$(ledscreen:current_title)`                  | Naam van de actieve titel                          |

Vervang `ledscreen` door de naam van jouw verbinding als je die anders genoemd hebt.

### Presets

- **Select Screen / Select Group**: selectieknoppen met preview en groene highlight.
- **Preview**: knoppen die alleen de preview van een scherm of groep tonen.
- **Show / Show all**: een knop per show, voor de selectie of voor alle schermen.
- **Show icon / Show icon all**: een knop per logo.
- **Title**: een knop per opgeslagen titel die hem actief maakt. **Title + show**: maakt hem actief en zet het geselecteerde scherm op de Title show.
- **Scoreboard / Other**: SB regels (4, 6, 8), SB 0.0 en reactietijden.
- **Talm timer**: 1:00 t/m 6:00 en 30:00, aftellen tot tijdstip, Start, Stop, Reset.
- **Talm vlag**: ✓, ✗ en Clear.
- **Talm diepte**: `--` `-` `+` `++` om de basis te verschuiven, en dieptes van basis -20 t/m +10 cm. De tekst schuift mee met de basis.
- **Talm hoogte**: ⬇⬇ ⬇ ⬆ ⬆⬆ om de basis te verschuiven (10 cm / 1 cm) en een knop die de hoogte stuurt en toont.
