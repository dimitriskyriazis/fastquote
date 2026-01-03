import Image from 'next/image';
import telmacoLogo from './telmaco.jpg';
import styles from './page.module.css';
import RecentOffersSection from './RecentOffersSection';

export default function Page() {
  return (
    <main className={styles.homePage}>
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <h1 className={styles.heroTitle}>FastQuote</h1>
          <div className={styles.heroMiddle}>
            <p className={styles.tagline}>
              FastQuote surfaces the offers you’ve been working on, plus the pricing, products, 
              and approvals that need attention, so you can manage deals and the surrounding tasks from the same dashboard.
            </p>
          </div>
          <p className={`${styles.heroCaption} ${styles.signature}`}>Created by Dimitris Kyriazis</p>
        </div>
        <div className={styles.heroImage}>
          <Image
            src={telmacoLogo}
            alt="Telmaco logo"
            className={styles.logoImage}
            loading="eager"
          />
          <p className={styles.heroCaption}>Powered by Telmaco</p>
        </div>
      </section>

      <RecentOffersSection />
    </main>
  );
}
