import Link from 'next/link';
import CustomerCreateClient from './CustomerCreateClient';
import layoutStyles from '../customerDetail.module.css';

export default function Page() {
  const formId = 'customer-create-form';

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/customers" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to customers
          </Link>
        </div>
        <h1 className={layoutStyles.heading}>Add Customer</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <button
            type="submit"
            form={formId}
            className={`${layoutStyles.headerActionButton} page-header-button`}
          >
            Add customer and proceed to contacts
          </button>
        </div>
      </div>
      <div className={layoutStyles.pageBody}>
        <CustomerCreateClient
          customerGroups={[]}
          parentCustomers={[]}
          pricingPolicies={[]}
          importanceOptions={[]}
          countries={[]}
          formId={formId}
        />
      </div>
    </main>
  );
}
