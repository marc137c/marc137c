/* Menyen til Kebab Corner Halden, hentet fra restaurantens meny på foodora.
   Lag en ny fil på admin.html (meny fra bilde) og bytt ut denne når menyen endres.
   Finnes ikke filen, bruker siden menyen som står i index.html. */
window.MENY_DATA = {
  "meny": [
    {
      "kategori": "Kebab",
      "retter": [
        { "navn": "Kebab i pita", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [109] },
        { "navn": "Kebab rull", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [119] },
        { "navn": "Kebab tallerken", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [148] },
        { "navn": "Kyllingkebab i pita", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [135] },
        { "navn": "Biffkebab i pita", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [135] },
        { "navn": "Kyllingrull", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [148] },
        { "navn": "Biffrull", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [148] },
        { "navn": "Kyllingkebab tallerken", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [171] },
        { "navn": "Biffkebab tallerken", "tekst": "Med salat, tomat, agurk, løk og mais.", "pris": [171] }
      ]
    },
    {
      "kategori": "Middag",
      "retter": [
        { "navn": "Fish & chips", "tekst": "Fritert fisk med pommes frites, salat, tomat, løk, agurk, mais og remulade.", "pris": [172] },
        { "navn": "Biff snadder", "tekst": "Biff med stekt paprika, løk og champignon. Serveres med salat.", "pris": [195] },
        { "navn": "Kylling snadder", "tekst": "Kylling med stekt paprika, løk og champignon. Serveres med salat.", "pris": [195] },
        { "navn": "Løvstek tallerken", "tekst": "Med salat, tomat, agurk, løk, mais og bearnaise.", "pris": [172] },
        { "navn": "Falafeltallerken", "tekst": "Med salat, tomat, agurk, løk og mais. Jalapeños om du vil.", "pris": [149], "tag": "veg" },
        { "navn": "Falafelrull", "tekst": "Med salat, tomat, agurk, løk og mais. Jalapeños om du vil.", "pris": [115], "tag": "veg" },
        { "navn": "Nuggets og pommes", "tekst": "8 nuggets med pommes frites.", "pris": [105] },
        { "navn": "Pommes frites", "tekst": "Liten porsjon. Stor kan også bestilles.", "pris": [40] },
        { "navn": "Pommes med salat og dressing", "tekst": "Liten porsjon. Stor kan også bestilles.", "pris": [69] }
      ]
    },
    {
      "kategori": "Burgere",
      "retter": [
        { "navn": "Hamburger 100 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [80] },
        { "navn": "Hamburger 160 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [135] },
        { "navn": "Hamburger 320 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [189] },
        { "navn": "Biffburger 200 g", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [155] },
        { "navn": "Løvbiff burger", "tekst": "Med salat, tomat, agurk, løk, hamburgerdressing og sterk saus om du vil.", "pris": [125] },
        { "navn": "Döner burger 200 g", "tekst": "Biffburger med stekt döner, salat, tomat, agurk, løk, ost, hamburgerdressing og sterk saus om du vil.", "pris": [189] }
      ]
    },
    {
      "kategori": "Pizza",
      "storrelser": ["Medium", "Stor"],
      "retter": [
        { "navn": "Margherita", "tekst": "Tomatsaus og ost.", "pris": [182, 229] },
        { "navn": "Chicken tikka pizza", "tekst": "Tomatsaus, ost, marinert kylling, mais og fersk løk og paprika.", "pris": [229, 289] },
        { "navn": "Biff pizza", "tekst": "Tomatsaus, ost, marinert biff og fersk champignon, løk og paprika.", "pris": [229, 299] },
        { "navn": "Kebab pizza", "tekst": "Tomatsaus, ost, kebabkjøtt, pommes frites og fersk paprika og løk.", "pris": [229, 289] },
        { "navn": "Green house pizza", "tekst": "Tomatsaus, ost, mais, peppermix, oliven og fersk løk, paprika og champignon.", "pris": [199, 269], "tag": "veg" },
        { "navn": "Pepperoni spesial pizza", "tekst": "Tomatsaus, ost, pepperoni og fersk champignon.", "pris": [229, 289] },
        { "navn": "Mexican pizza", "tekst": "Chili-tomatsaus, ost, nachos chips, jalapeños, biff eller kylling og løk.", "pris": [229, 289], "tag": "hot" },
        { "navn": "Lag din egen pizza", "tekst": "Tomatsaus, ost og opptil 4 ingredienser.", "pris": [249, 329] },
        { "navn": "Smoke house pizza", "tekst": "Barbecuesaus, ost, kylling eller biff, jalapeños og fersk løk.", "pris": [229, 289] },
        { "navn": "Hawaii pizza", "tekst": "Tomatsaus, ost, kylling, mais og ananas.", "pris": [229, 289] },
        { "navn": "Kebab Corner spesial", "tekst": "Tomatsaus, ost, kylling, biff, mais, jalapeños og fersk løk og champignon.", "pris": [249, 329] }
      ]
    },
    {
      "kategori": "Drikke",
      "retter": [
        { "navn": "Brus 0,5 l", "tekst": "Cola, Cola Zero, Pepsi Max, Fanta Exotic, Villa, Solo, Fuze Tea Peach og Urge.", "pris": [40] },
        { "navn": "Vann 0,5 l", "tekst": "Isklar uten kullsyre eller Farris med kullsyre.", "pris": [40] },
        { "navn": "Brus 1,5 l", "tekst": "Cola, Pepsi Max, Urge og Fanta Exotic.", "pris": [73] },
        { "navn": "Red Bull 0,25 l", "pris": [40] },
        { "navn": "Monster", "tekst": "Original, Monarch, Mango Loco, Ultra Fiesta Mango, Ultra Gold, Ultra Rosa og Lewis Hamilton.", "pris": [45] },
        { "navn": "Prime 0,5 l", "tekst": "Lime, Blue Raspberry, Tropical Punch, Ice Pop og Jordbær Vannmelon.", "pris": [45] }
      ]
    }
  ]
};
