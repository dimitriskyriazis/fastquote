import Image from 'next/image';
import Link from 'next/link';
import telmacoLogo from './telmaco.jpg';
import styles from './page.module.css';
import DashboardStats from './DashboardStats';
import RecentOffersSection from './RecentOffersSection';
import {
  OffersIcon,
  PriceListsIcon,
  PricingPoliciesIcon,
  ProductsIcon,
  StandardPackagesIcon,
  CustomersIcon,
  ContactsIcon,
  SuppliersIcon,
  MarketingIcon,
} from './components/NavIcons';

const quickLinks = [
  { label: 'Offers', href: '/offers', icon: <OffersIcon size={28} /> },
  { label: 'Price Lists', href: '/price-lists', icon: <PriceListsIcon size={28} /> },
  { label: 'Pricing Policies', href: '/pricing-policies', icon: <PricingPoliciesIcon size={28} /> },
  { label: 'Products', href: '/products', icon: <ProductsIcon size={28} /> },
  { label: 'Std. Packages', href: '/standard-packages', icon: <StandardPackagesIcon size={28} /> },
  { label: 'Customers', href: '/customers', icon: <CustomersIcon size={28} /> },
  { label: 'Contacts', href: '/contacts', icon: <ContactsIcon size={28} /> },
  { label: 'Suppliers', href: '/suppliers', icon: <SuppliersIcon size={28} /> },
  { label: 'Marketing', href: '/marketing', icon: <MarketingIcon size={28} /> },
];

export default function Page() {
  return (
    <main className={styles.homePage}>
      <header className={styles.topBar}>
        <div className={styles.brandRow}>
          <h1 className={styles.brandTitle}>FastQuote</h1>
          <div className={styles.poweredBy}>
            <Image
              src={telmacoLogo}
              alt="Telmaco logo"
              className={styles.logoImage}
              loading="eager"
            />
          </div>
        </div>
        <hr className={styles.divider} />
        <nav className={styles.quickLinks}>
          {quickLinks.map((link) => (
            <Link key={link.href} href={link.href} className={styles.quickLink}>
              <span className={styles.quickLinkIcon}>{link.icon}</span>
              <span className={styles.quickLinkLabel}>{link.label}</span>
            </Link>
          ))}
        </nav>
      </header>

      <RecentOffersSection />

      <DashboardStats />
    </main>
  );
}
