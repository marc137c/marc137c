/* Menyen til Kebab Corner Halden.
   Denne filen lages på admin.html (meny fra bilde). Last ned en ny fil der og bytt ut denne.
   Finnes ikke filen, bruker siden menyen som står i index.html. */
window.MENY_DATA = {
  "meny": [
    {
      "kategori": "Kebab",
      "retter": [
        { "navn": "Kebab i pita", "pris": [109], "allergener": ["G", "SO"] },
        { "navn": "Kebab rull", "pris": [119], "allergener": ["G", "SO"] },
        { "navn": "Kebab tallerken", "pris": [149], "allergener": ["SO", "SE"] },
        { "navn": "Kyllingkebab i pita", "pris": [145], "allergener": ["G"] },
        { "navn": "Biffkebab i pita", "pris": [149], "allergener": ["G"] },
        { "navn": "Kyllingrull", "pris": [155], "allergener": ["G"] },
        { "navn": "Biffrull", "pris": [159], "allergener": ["G"] }
      ]
    }
  ],
  "allergener": { "G": "Gluten", "SO": "Soya", "M": "Melk", "F": "Fisk", "SE": "ikke oppgitt", "H": "ikke oppgitt" }
};
