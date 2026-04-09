import { Actor } from 'apify';
import { PuppeteerCrawler, sleep } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();

const {
    industry = 'Software Engineering',
    minFollowers = 20000,
    maxProfiles = 100,
    linkedInCookies = [],
    location = '',
} = input;

// Use industry directly as the LinkedIn search query
const searchQuery = industry;

console.log(`🔍 Searching for: "${industry}" | Min followers: ${minFollowers.toLocaleString()}`);

if (!linkedInCookies || linkedInCookies.length === 0) {
    throw new Error(
        'LinkedIn cookies are required. Please provide your li_at session cookie.'
    );
}

const dataset = await Actor.openDataset('linkedin-leads');

// Build LinkedIn search URL
function buildSearchUrl(query, location, page = 1) {
    const base = 'https://www.linkedin.com/search/results/people/';
    const params = new URLSearchParams({
        keywords: query,
        origin: 'GLOBAL_SEARCH_HEADER',
        page: page.toString(),
    });
    if (location) params.set('geoUrn', location);
    return `${base}?${params.toString()}`;
}

// Parse follower count strings like "23K", "1.2M", "45,000"
function parseFollowerCount(text) {
    if (!text) return 0;
    const clean = text.replace(/,/g, '').trim().toUpperCase();
    const match = clean.match(/([\d.]+)\s*([KM]?)/);
    if (!match) return 0;
    let num = parseFloat(match[1]);
    if (match[2] === 'K') num *= 1_000;
    if (match[2] === 'M') num *= 1_000_000;
    return Math.round(num);
}

// Extract profile data from a LinkedIn profile page
async function extractProfileData(page, profileUrl) {
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000 + Math.random() * 2000);

    return page.evaluate(() => {
        const getText = (selector) =>
            document.querySelector(selector)?.innerText?.trim() || '';

        const name = getText('h1.text-heading-xlarge');
        const headline = getText('.text-body-medium.break-words');
        const location = getText('.text-body-small.inline.t-black--light.break-words');

        // Follower count — LinkedIn shows it in the "connections" section
        const followerEl = [...document.querySelectorAll('span')].find((el) =>
            el.innerText?.toLowerCase().includes('follower')
        );
        const followerText = followerEl?.innerText || '';

        // Profile image
        const profileImage =
            document.querySelector('.pv-top-card-profile-picture__image')?.src || '';

        // About section
        const about = getText('#about ~ .display-flex .visually-hidden') ||
            getText('.pv-about__summary-text');

        // Current position
        const currentTitle = getText(
            '.experience-section .pv-entity__summary-info h3'
        ) || getText('[data-field="experience_company_logo"] + div h3');

        const currentCompany = getText(
            '.experience-section .pv-entity__secondary-title'
        );

        // Skills
        const skillEls = document.querySelectorAll('.pv-skill-category-entity__name-text');
        const skills = [...skillEls].slice(0, 10).map((el) => el.innerText.trim());

        // Connections count
        const connectionsEl = [...document.querySelectorAll('span')].find((el) =>
            el.innerText?.toLowerCase().includes('connection')
        );

        return {
            name,
            headline,
            location,
            followerText,
            about: about.slice(0, 500),
            currentTitle,
            currentCompany,
            skills,
            connectionsText: connectionsEl?.innerText || '',
            profileImage,
            profileUrl: window.location.href,
            scrapedAt: new Date().toISOString(),
        };
    });
}

// Extract profile URLs from a search results page
async function extractSearchResults(page) {
    return page.evaluate(() => {
        const cards = document.querySelectorAll(
            '.entity-result__item a.app-aware-link[href*="/in/"]'
        );
        return [...new Set([...cards].map((a) => {
            const url = new URL(a.href);
            return `${url.origin}${url.pathname}`;
        }))];
    });
}

let totalScraped = 0;
let currentPage = 1;
const profileUrls = new Set();

const crawler = new PuppeteerCrawler({
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // Inject LinkedIn session cookies
            await page.setCookie(
                ...linkedInCookies.map((cookie) => ({
                    name: cookie.name,
                    value: cookie.value,
                    domain: '.linkedin.com',
                    path: '/',
                    httpOnly: true,
                    secure: true,
                }))
            );

            // Set realistic user agent
            await page.setUserAgent(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            );
        },
    ],

    requestHandler: async ({ page, request }) => {
        const { url, label } = request;

        // ── SEARCH PAGE ──────────────────────────────────────────────
        if (label === 'SEARCH') {
            console.log(`Scraping search page ${currentPage}: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            await sleep(3000 + Math.random() * 2000);

            // Check if we're redirected to login
            if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
                throw new Error(
                    'LinkedIn redirected to login. Your cookies may have expired.'
                );
            }

            const foundUrls = await extractSearchResults(page);
            console.log(`Found ${foundUrls.length} profiles on page ${currentPage}`);

            for (const profileUrl of foundUrls) {
                if (!profileUrls.has(profileUrl) && totalScraped < maxProfiles) {
                    profileUrls.add(profileUrl);
                    await crawler.addRequests([
                        { url: profileUrl, label: 'PROFILE' },
                    ]);
                }
            }

            // Queue next search page if we need more profiles
            if (totalScraped < maxProfiles && foundUrls.length > 0) {
                currentPage++;
                const nextUrl = buildSearchUrl(searchQuery, location, currentPage);
                await crawler.addRequests([{ url: nextUrl, label: 'SEARCH' }]);
            }
        }

        // ── PROFILE PAGE ─────────────────────────────────────────────
        else if (label === 'PROFILE') {
            if (totalScraped >= maxProfiles) return;

            console.log(`Scraping profile: ${url}`);
            const data = await extractProfileData(page, url);

            const followerCount = parseFollowerCount(data.followerText);
            data.followerCount = followerCount;

            // Filter by minimum followers
            if (followerCount < minFollowers) {
                console.log(
                    `Skipping ${data.name} — only ${followerCount} followers (min: ${minFollowers})`
                );
                return;
            }

            // Filter by job title/headline matching the requested industry
            const titleLower = (data.headline + ' ' + data.currentTitle).toLowerCase();
            const industryKeywords = industry.toLowerCase().split(/\s+/);
            const titleMatches = industryKeywords.some((kw) => titleLower.includes(kw));
            if (!titleMatches) {
                console.log(`Skipping ${data.name} — title doesn't match industry: "${industry}"`);
                return;
            }

            console.log(
                `✅ Saved lead: ${data.name} | ${followerCount.toLocaleString()} followers`
            );

            await dataset.pushData(data);
            totalScraped++;

            // Rate-limit: be polite to LinkedIn
            await sleep(4000 + Math.random() * 3000);
        }
    },

    maxConcurrency: 1, // Stay low to avoid rate limiting
    maxRequestRetries: 2,

    failedRequestHandler: async ({ request, error }) => {
        console.error(`Failed: ${request.url} — ${error.message}`);
        await Actor.pushData({
            url: request.url,
            error: error.message,
            scrapedAt: new Date().toISOString(),
        });
    },
});

// Kick off with the first search page
const firstUrl = buildSearchUrl(searchQuery, location, 1);
await crawler.run([{ url: firstUrl, label: 'SEARCH' }]);

console.log(`\n🎉 Done! Scraped ${totalScraped} qualified leads.`);
console.log(`Dataset: https://console.apify.com/storage/datasets/${dataset.id}`);

await Actor.exit();
