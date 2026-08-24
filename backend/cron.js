/**
 * ✦ ScrapeVerse — 24-Hour Background Auto-Scraping Cron Engine
 * 
 * Case 3: Runs every 24 hours to check alert / watched products
 * Checks ONLY for Price change or Name change (No review checks / No LLM calls)
 * - If Price changed: updates price in DB, adds history point, and alerts user
 * - If Name changed: updates name in DB
 */

const db = require('./db-loader');
const { recheckProduct } = require('./product-recheck');

class BackgroundAutoScraper {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
  }

  /**
   * Starts 24-Hour background auto-scraping interval
   */
  start(intervalMs = 24 * 60 * 60 * 1000) {
    console.log('⚡ [Auto-Scraper] Initializing 24-Hour Background Scraping Engine (Case 3: Alert Products)...');
    
    // Initial check after 10 seconds of startup
    setTimeout(() => {
      this.run24HourScrapeCycle('startup_initial');
    }, 10000);

    // Recurring 24-Hour Interval
    this.intervalId = setInterval(() => {
      this.run24HourScrapeCycle('scheduled_24h_cycle');
    }, intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Executes 24-Hour Cycle
   */
  async run24HourScrapeCycle(triggerSource = 'manual') {
    if (this.isRunning) {
      console.log('⏳ [Auto-Scraper] Previous 24h cycle still running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    console.log(`\n🔄 [Auto-Scraper] Starting 24-Hour Check Cycle (Trigger: ${triggerSource})...`);

    try {
      // Fetch ONLY products with active alerts that have NOT been visited/checked in the last 24 hours
      const alertProducts = db.getWatchedProductsNeeding24hCheck ? await db.getWatchedProductsNeeding24hCheck() : [];
      if (!alertProducts || alertProducts.length === 0) {
        console.log('ℹ️ [Auto-Scraper 24h] All alert products are up-to-date within the 24h window (0 products need scraping).');
        this.isRunning = false;
        return;
      }

      console.log(`📊 [Auto-Scraper 24h] Checking ${alertProducts.length} alert product(s) that haven't been visited in 24 hours...`);

      for (const prod of alertProducts) {
        await this.checkPriceAndNameOnly(prod);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ [Auto-Scraper] 24-Hour Cycle finished in ${elapsed}s!\n`);
    } catch (err) {
      console.error('❌ [Auto-Scraper] Encountered error:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Case 3 Check: Shared product JSON recheck (No review check)
   */
  async checkPriceAndNameOnly(product) {
    try {
      const result = await recheckProduct(product, { source: 'Auto-Scraper 24h' });
      if (!result.success) {
        console.warn(`[Auto-Scraper 24h] Product #${product.id} was not rechecked: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[Auto-Scraper] Error checking product #${product.id}:`, err.message);
    }
  }
}

module.exports = new BackgroundAutoScraper();
