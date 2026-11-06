export type SeedPublisher = { name: string; domain: string; loginUrl: string };

/**
 * A starting list for the Subscriptions tab, not a definition of what Newsy
 * supports — you can add any site, and these can be deleted. They are the
 * paywalled publishers that actually appear in this install's feeds and matched
 * articles, so the tab is useful the first time it is opened.
 *
 * `domain` is the *cookie* domain, which is what the shell queries the session
 * jar with. It is deliberately registrable-domain only (`wsj.com`, not
 * `www.wsj.com`), because publishers set auth cookies on the parent so they
 * carry across `www`, `login` and API subdomains alike.
 *
 * Login URLs drift. If one 404s, add the site again from the Subscriptions tab
 * with a working URL — adding an existing domain overwrites its login page
 * rather than creating a duplicate. Nothing here is load-bearing beyond giving
 * the "Sign in" button somewhere to start.
 */
export const SEED_PUBLISHERS: SeedPublisher[] = [
  { name: 'The Wall Street Journal', domain: 'wsj.com', loginUrl: 'https://www.wsj.com/client/login' },
  { name: 'MarketWatch', domain: 'marketwatch.com', loginUrl: 'https://www.marketwatch.com/client/login' },
  { name: 'Barron’s', domain: 'barrons.com', loginUrl: 'https://www.barrons.com/client/login' },
  { name: 'Bloomberg', domain: 'bloomberg.com', loginUrl: 'https://www.bloomberg.com/account/signin' },
  { name: 'The New York Times', domain: 'nytimes.com', loginUrl: 'https://myaccount.nytimes.com/auth/login' },
  { name: 'The Washington Post', domain: 'washingtonpost.com', loginUrl: 'https://www.washingtonpost.com/subscribe/signin/' },
  { name: 'Financial Times', domain: 'ft.com', loginUrl: 'https://www.ft.com/login' },
  { name: 'The Economist', domain: 'economist.com', loginUrl: 'https://www.economist.com/api/auth/login' },
  { name: 'The Atlantic', domain: 'theatlantic.com', loginUrl: 'https://accounts.theatlantic.com/login/' },
  { name: 'Business Insider', domain: 'businessinsider.com', loginUrl: 'https://www.businessinsider.com/login' },
  { name: 'MIT Technology Review', domain: 'technologyreview.com', loginUrl: 'https://www.technologyreview.com/login/' },
  { name: 'Seeking Alpha', domain: 'seekingalpha.com', loginUrl: 'https://seekingalpha.com/account/login' },
  { name: 'The Information', domain: 'theinformation.com', loginUrl: 'https://www.theinformation.com/login' },
  { name: 'Fortune', domain: 'fortune.com', loginUrl: 'https://fortune.com/signin/' },
];
