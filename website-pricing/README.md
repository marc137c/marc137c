# Website price list

Internal price list and quote calculator for the websites we build. Open `index.html` in a browser, tick what the client wants, and the quote adds it up.

- Packages: landing page, basic website, business website, webshop
- Languages: pick the main language and any extra languages (English, Norwegian, Sámi, German and more), with optional translation per page
- Add-ons: night mode, contact form, booking, blog, logo, SEO, universal design and more
- Ongoing services: hosting, maintenance, email accounts, domain renewal
- Adjustments: rush delivery, discount, custom lines, MVA on or off
- "Copy quote as text" gives a plain-text quote to paste into an email

All prices are NOK excluding 25% MVA.

## Changing prices

Every price lives in the `PRICES` list at the top of the `<script>` in `index.html`. Change a number, save, and reload the page. To add a new add-on, copy one of the existing lines in the right group and give it a new `id`.

The calculator remembers your last quote in the browser. Press **Clear** twice to start a new one.
