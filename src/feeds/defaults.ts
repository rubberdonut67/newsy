export type SeedFeed = { url: string; title: string; category: string };

/**
 * The baseline repository of sources, seeded on first boot. A few majors
 * (Reuters, AP, Bloomberg) retired their public RSS endpoints, so they come in
 * through a site-scoped Google News query instead — same articles, still free.
 */
export const DEFAULT_FEEDS: SeedFeed[] = [
  // --- Wires & world ---
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC News', category: 'world' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', title: 'BBC World', category: 'world' },
  { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian — World', category: 'world' },
  { url: 'https://www.theguardian.com/us-news/rss', title: 'The Guardian — US', category: 'us' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera', category: 'world' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml', title: 'Sky News — World', category: 'world' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', title: 'NYT — World', category: 'world' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', title: 'NYT — Home Page', category: 'world' },
  {
    // The Post's own feeds.washingtonpost.com endpoints answer 502 to everything
    // (checked 2026-11-05), so it comes in the way Reuters and AP do.
    url: 'https://news.google.com/rss/search?q=site:washingtonpost.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    title: 'Washington Post (via Google News)',
    category: 'world',
  },
  { url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', title: 'WSJ — World', category: 'world' },
  { url: 'https://www.economist.com/latest/rss.xml', title: 'The Economist', category: 'world' },
  { url: 'https://www.ft.com/rss/home', title: 'Financial Times', category: 'business' },
  {
    url: 'https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    title: 'Reuters (via Google News)',
    category: 'world',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    title: 'Associated Press (via Google News)',
    category: 'world',
  },
  {
    url: 'https://news.google.com/rss/search?q=site:bloomberg.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    title: 'Bloomberg (via Google News)',
    category: 'business',
  },

  // --- US news & politics ---
  { url: 'https://feeds.npr.org/1001/rss.xml', title: 'NPR — News', category: 'us' },
  { url: 'https://feeds.nbcnews.com/nbcnews/public/news', title: 'NBC News', category: 'us' },
  { url: 'https://www.cbsnews.com/latest/rss/main', title: 'CBS News', category: 'us' },
  { url: 'https://abcnews.go.com/abcnews/topstories', title: 'ABC News', category: 'us' },
  { url: 'https://moxie.foxnews.com/google-publisher/latest.xml', title: 'Fox News', category: 'us' },
  { url: 'https://rss.politico.com/politics-news.xml', title: 'Politico', category: 'politics' },
  { url: 'https://thehill.com/news/feed/', title: 'The Hill', category: 'politics' },
  { url: 'https://api.axios.com/feed/', title: 'Axios', category: 'us' },
  { url: 'https://www.propublica.org/feeds/propublica/main', title: 'ProPublica', category: 'us' },
  { url: 'https://www.vox.com/rss/index.xml', title: 'Vox', category: 'us' },
  { url: 'https://www.theatlantic.com/feed/all/', title: 'The Atlantic', category: 'us' },
  { url: 'https://time.com/feed/', title: 'TIME', category: 'us' },
  { url: 'https://www.semafor.com/rss.xml', title: 'Semafor', category: 'us' },

  // --- Business & markets ---
  {
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
    title: 'CNBC — Top News',
    category: 'business',
  },
  {
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
    title: 'CNBC — Finance',
    category: 'business',
  },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', title: 'WSJ — Markets', category: 'business' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', title: 'NYT — Business', category: 'business' },
  { url: 'https://www.businessinsider.com/rss', title: 'Business Insider', category: 'business' },
  { url: 'https://fortune.com/feed/fortune-feeds/?id=3230629', title: 'Fortune', category: 'business' },

  // --- Technology ---
  { url: 'https://techcrunch.com/feed/', title: 'TechCrunch', category: 'tech' },
  { url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge', category: 'tech' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica', category: 'tech' },
  { url: 'https://www.wired.com/feed/rss', title: 'WIRED', category: 'tech' },
  { url: 'https://www.engadget.com/rss.xml', title: 'Engadget', category: 'tech' },
  { url: 'https://feeds.a.dj.com/rss/RSSWSJD.xml', title: 'WSJ — Tech', category: 'tech' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', title: 'NYT — Technology', category: 'tech' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', title: 'BBC — Technology', category: 'tech' },
  { url: 'https://www.technologyreview.com/feed/', title: 'MIT Technology Review', category: 'tech' },
  { url: 'https://www.404media.co/rss/', title: '404 Media', category: 'tech' },
  { url: 'https://hnrss.org/frontpage', title: 'Hacker News — Front Page', category: 'tech' },
  { url: 'https://lobste.rs/rss', title: 'Lobsters', category: 'tech' },

  // --- AI ---
  { url: 'https://openai.com/news/rss.xml', title: 'OpenAI', category: 'ai' },
  { url: 'https://blog.google/technology/ai/rss/', title: 'Google AI Blog', category: 'ai' },
  { url: 'https://huggingface.co/blog/feed.xml', title: 'Hugging Face Blog', category: 'ai' },
  { url: 'https://rss.arxiv.org/rss/cs.AI', title: 'arXiv — cs.AI', category: 'ai' },
  { url: 'https://rss.arxiv.org/rss/cs.LG', title: 'arXiv — cs.LG', category: 'ai' },
  {
    url: 'https://news.google.com/rss/search?q=%22artificial+intelligence%22+when:1d&hl=en-US&gl=US&ceid=US:en',
    title: 'AI headlines (Google News)',
    category: 'ai',
  },

  // --- Science & health ---
  { url: 'https://www.nature.com/nature.rss', title: 'Nature', category: 'science' },
  { url: 'https://www.sciencedaily.com/rss/all.xml', title: 'ScienceDaily', category: 'science' },
  { url: 'https://phys.org/rss-feed/', title: 'Phys.org', category: 'science' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml', title: 'NYT — Science', category: 'science' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml', title: 'NYT — Health', category: 'health' },
  { url: 'https://www.statnews.com/feed/', title: 'STAT News', category: 'health' },

  // --- Sport & culture ---
  { url: 'https://www.espn.com/espn/rss/news', title: 'ESPN', category: 'sport' },
  { url: 'https://www.theguardian.com/uk/sport/rss', title: 'The Guardian — Sport', category: 'sport' },
  { url: 'https://variety.com/feed/', title: 'Variety', category: 'culture' },
];

/**
 * Default feeds that have since died for good. Removed from existing installs at
 * startup so they stop failing every poll; their articles stay (feed_id goes NULL).
 */
export const RETIRED_FEEDS: string[] = [
  'https://feeds.washingtonpost.com/rss/world',
  'https://feeds.washingtonpost.com/rss/business',
];
