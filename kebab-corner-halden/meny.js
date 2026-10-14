/* Menyen til Kebab Corner Halden, lest av menytavlene i restauranten.
   Lag en ny fil på admin.html (meny fra bilde) og bytt ut denne når menyen endres.
   Finnes ikke filen, bruker siden menyen som står i index.html. */
window.MENY_DATA = {
  "meny": [
    {
      "kategori": "Kebab",
      "retter": [
        { "navn": "Kebab i pita", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [109], "allergener": ["G", "SO"] },
        { "navn": "Kebab rull", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [119], "allergener": ["G", "SO"] },
        { "navn": "Kebab tallerken", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [149], "allergener": ["SO", "SE"] },
        { "navn": "Kyllingkebab i pita", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [145], "allergener": ["G"] },
        { "navn": "Biffkebab i pita", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [149], "allergener": ["G"] },
        { "navn": "Kyllingrull", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [155], "allergener": ["G"] },
        { "navn": "Biffrull", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [159], "allergener": ["G"] },
        { "navn": "Kyllingkebab tallerken", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [175], "allergener": ["SE"] },
        { "navn": "Biffkebab tallerken", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [179], "allergener": ["SE"] }
      ]
    },
    {
      "kategori": "Pizza",
      "storrelser": ["Medium", "Stor"],
      "retter": [
        { "navn": "Margherita", "tekst": "Tomatsaus og ost.", "pris": [169, 219] },
        { "navn": "Chicken tikka pizza", "tekst": "Tomatsaus, ost, marinert kylling, mais og fersk løk og paprika.", "pris": [209, 269] },
        { "navn": "Biff pizza", "tekst": "Tomatsaus, ost, marinert biff, sopp og fersk løk og paprika.", "pris": [209, 289] },
        { "navn": "Kebab pizza", "tekst": "Tomatsaus, ost, kebabkjøtt, pommes frites og fersk paprika og champignon.", "pris": [209, 289] },
        { "navn": "Seafood pizza", "tekst": "Tomatsaus, ost, tunfisk og mais.", "pris": [199, 279] },
        { "navn": "Pepperoni spesial pizza", "tekst": "Tomatsaus, ost, pepperoni og fersk champignon.", "pris": [209, 289] },
        { "navn": "Green house pizza", "tekst": "Tomatsaus, ost, mais, peppermix, oliven, ananas og fersk løk, paprika og champignon.", "pris": [199, 250] },
        { "navn": "Mexican pizza", "tekst": "Chili-tomatsaus, ost, nachos chips, jalapeños, valgfritt kjøtt og løk.", "pris": [209, 289], "tag": "hot" },
        { "navn": "Lag din egen pizza", "tekst": "Tomatsaus, ost og opptil 4 ingredienser.", "pris": [250, 300] },
        { "navn": "Smoke house pizza", "tekst": "Barbecuesaus, ost, kylling eller biff, jalapeños og fersk løk.", "pris": [209, 289] },
        { "navn": "Hawaii pizza", "tekst": "Tomatsaus, ost, kylling, mais og ananas.", "pris": [209, 279] },
        { "navn": "Kebab Corner spesial", "tekst": "Tomatsaus, ost, kylling, biff, mais, jalapeños og fersk løk og champignon.", "pris": [250, 300] },
        { "navn": "Garlic brød", "tekst": "Hvitløkssmør.", "pris": [109, 149] },
        { "navn": "Garlic brød med ost", "tekst": "Hvitløkssmør og ost.", "pris": [139, 189] },
        { "navn": "Garlic brød supreme", "tekst": "Hvitløkssmør, ost, fersk champignon og løk.", "pris": [159, 199] }
      ]
    },
    {
      "kategori": "Burgere",
      "retter": [
        { "navn": "Hamburger 100 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [89], "allergener": ["G"] },
        { "navn": "Hamburger 160 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [139], "allergener": ["G"] },
        { "navn": "Hamburger 320 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [189], "allergener": ["G"] },
        { "navn": "Biffburger 200 g", "tekst": "Hjemmelaget. Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [159], "allergener": ["G"] },
        { "navn": "Løvbiff burger", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [129] },
        { "navn": "Döner burger", "tekst": "Burger med stekt döner, salat, tomat, agurk, løk, ost, hamburgerdressing og sterk saus om du vil.", "pris": [99] },
        { "navn": "Mexican burger", "tekst": "19 kr i tillegg til burgeren.", "pris": [19] },
        { "navn": "Hawaii burger", "tekst": "19 kr i tillegg til burgeren.", "pris": [19] },
        { "navn": "Barbecue burger", "tekst": "19 kr i tillegg til burgeren.", "pris": [19] },
        { "navn": "Ost på burgeren", "pris": [15], "allergener": ["M"] }
      ]
    },
    {
      "kategori": "Middag",
      "retter": [
        { "navn": "Fish & chips", "tekst": "Fritert fisk med pommes frites, salat, tomat, løk, agurk, mais og remulade.", "pris": [169], "allergener": ["F", "SE", "H"] },
        { "navn": "Biff snadder", "tekst": "Biff med stekt paprika, løk og champignon. Serveres med salat.", "pris": [195], "allergener": ["SE"] },
        { "navn": "Kylling snadder", "tekst": "Kylling med stekt paprika, løk og champignon. Serveres med salat.", "pris": [189], "allergener": ["SE"] },
        { "navn": "Løvstek tallerken", "tekst": "Med salat, tomat, agurk, løk, mais og bearnaise.", "pris": [169], "allergener": ["SE"] },
        { "navn": "Nuggets og pommes", "tekst": "8 nuggets med pommes frites.", "pris": [99], "allergener": ["H", "SE"] },
        { "navn": "Falafelrull", "tekst": "Med salat, tomat, agurk, løk og mais. Jalapeños om du vil.", "pris": [119], "allergener": ["H"] },
        { "navn": "Falafeltallerken", "tekst": "Med salat, tomat, agurk, løk og mais. Jalapeños om du vil.", "pris": [149], "allergener": ["H", "SE"] }
      ]
    },
    {
      "kategori": "Tilbehør og drikke",
      "retter": [
        { "navn": "Pommes frites", "tekst": "Liten eller stor.", "pris": [39, 69], "allergener": ["SE"] },
        { "navn": "Pommes med salat og dressing", "tekst": "Liten eller stor.", "pris": [69, 89] },
        { "navn": "Loaded fries", "pris": [119] },
        { "navn": "Pitabrød", "pris": [15], "allergener": ["G"] },
        { "navn": "Ekstra kjøtt i kebaben", "pris": [39], "allergener": ["SO"] },
        { "navn": "Ost i kebaben", "pris": [19], "allergener": ["M"] },
        { "navn": "Ananas i kebaben", "pris": [19] },
        { "navn": "Ekstra saus i beger", "pris": [29] },
        { "navn": "Drikke", "tekst": "Cola, Cola Zero, Pepsi Max, Fanta Exotic, Solo, Villa, Urge, Fuze Tea Peach, Farris og Isklar.", "pris": [35, 40] },
        { "navn": "Energidrikke", "tekst": "Red Bull, Monster og Prime i flere smaker.", "pris": [40] },
        { "navn": "Drikke 1,5 l", "tekst": "Cola, Pepsi Max, Urge og Fanta Exotic.", "pris": [60] }
      ]
    }
  ],
  "allergener": { "G": "Gluten", "SO": "Soya", "M": "Melk", "F": "Fisk", "SE": "ikke oppgitt", "H": "ikke oppgitt" }
};
