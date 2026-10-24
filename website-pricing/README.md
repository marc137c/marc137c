# Website price list

Internal price list and quote calculator for the websites we build. Open `index.html` in a browser, tick what the client wants, and the quote adds it up.

- Packages: landing page, basic website, business website, webshop
- Languages: pick the main language and any extra languages (English, Norwegian, Sámi, German and more), with optional translation per page
- Planning and design: kickoff workshop, competitor review, wireframes, clickable prototype
- Features: night mode, contact form, booking, blog, live chat, AI chat assistant, event calendar, job listings and more
- Webshop extras: shipping (Bring, PostNord, Helthjem), Klarna, accounting integration (Fiken, Tripletex), variants, subscriptions
- Content and branding: logo, copywriting, photo shoot, product photos, promo video, social media templates
- Technical and launch: SEO, rich results, universal design, accessibility statement, security, redirects, client training
- Ongoing services and marketing: hosting, maintenance, uptime monitoring, monthly SEO, Google Ads, social media, blog posts
- Adjustments: rush delivery, discount, custom lines, MVA on or off
- "Copy quote as text" gives a plain-text quote to paste into an email
- Norwegian and English: switch with NO / EN in the header. The page starts in Norwegian when the browser is set to Norwegian, and the copied quote is in the language on screen.

All prices are NOK excluding 25% MVA.

## Changing prices

Every price lives in the `PRICES` list at the top of the `<script>` in `index.html`. Change a number, save, and reload the page. To add a new add-on, copy one of the existing items in the right group, give it a new `id`, and write its `name` and `desc` in both English (`en`) and Norwegian (`no`).

Add-on prices are estimated as hours of work × the 750 kr hourly rate. For comparison, Norwegian agencies typically charge 1 000–1 800 kr per hour and 25 000–60 000 kr for a simple business site, so these prices sit at the budget end.

The calculator remembers your last quote in the browser. Press **Clear** twice to start a new one.
