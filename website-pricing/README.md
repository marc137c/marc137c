# Website price list

Internal price list and quote calculator for the websites we build. Open `index.html` in a browser, tick what the client wants, and the quote adds it up.

- Packages: landing page, basic website, business website, webshop
- Languages: pick the main language and any extra languages (English, Norwegian, Sámi, German and more), with optional translation per page
- Planning and design: kickoff questionnaire, competitor review, wireframes, clickable prototype
- Features: night mode, contact form, booking, blog, live chat, AI chat assistant, event calendar, job listings and more
- Vipps: Vipps payment, Log in with Vipps, recurring payments with Vipps, Vipps Express Checkout (Hurtigkasse) for webshops
- Webshop extras: shipping (Bring, PostNord, Helthjem), Klarna, accounting integration (Fiken, Tripletex), variants, subscriptions
- Content and branding: logo, copywriting, photo guide and editing, product photos from the client's phone photos, animated promo video, social media templates in Figma
- Technical and launch: SEO, rich results, universal design, accessibility statement, security, redirects, written client guide
- Ongoing services and marketing: hosting, maintenance, uptime monitoring, monthly SEO, Google Ads, social media, blog posts
- Adjustments: rush delivery, discount, custom lines, MVA on or off
- "Copy quote as text" gives a plain-text quote to paste into an email
- Norwegian and English: switch with NO / EN in the header. The page starts in Norwegian when the browser is set to Norwegian, and the copied quote is in the language on screen.

All prices are NOK excluding 25% MVA.

## Changing prices

Every price lives in the `PRICES` list at the top of the `<script>` in `index.html`. Change a number, save, and reload the page. To add a new add-on, copy one of the existing items in the right group, give it a new `id`, and write its `name` and `desc` in both English (`en`) and Norwegian (`no`).

Add-on prices are estimated as hours of work × the 750 kr hourly rate. For comparison, Norwegian agencies typically charge 1 000–1 800 kr per hour and 25 000–60 000 kr for a simple business site, so these prices sit at the budget end.

## What is on the list

Every service is something we can deliver ourselves, with the AI tools and connected services we build with. Nothing needs us on site or in a live meeting. Where a step can only be done by the client, the description or the section note says so. Typical client steps are signing an agreement with Vipps, Klarna or a card provider, verifying the business with Google, registering a .no domain, giving us account access or API keys, and paying third-party fees such as ad spend and licences.

Some services were changed to fit this. An on-site photo shoot became a photo guide and editing of the client's own photos. A filmed promo video became an animated one made from the client's material. A live workshop and live training became a written questionnaire and a written guide. Vipps Checkout became Vipps Express Checkout (Hurtigkasse), because Vipps Checkout is no longer sold to new merchants and closes on 30 April 2027. Northern Sámi translations are delivered as a draft that a native speaker checks. Priority support and uptime fixes rely on a scheduled check that runs at least every few working hours.

The calculator remembers your last quote in the browser. Press **Clear** twice to start a new one.
