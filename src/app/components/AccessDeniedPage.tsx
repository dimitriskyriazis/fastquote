'use client';

type Props = {
  windowsIdentity?: string | null;
};

export default function AccessDeniedPage({ windowsIdentity }: Props) {
  return (
    <div className="access-denied-page">
      <div className="access-denied-page__card">
        <h1 className="access-denied-page__title">Access denied</h1>
        <p className="access-denied-page__message">
          You signed in with a domain account that is not authorized for this application.
        </p>
        <p className="access-denied-page__contact">
          To request access, please contact <strong>Dimitris Kyriazis (dim.kyriazis@telmaco.gr)</strong>.
        </p>
        {windowsIdentity && (
          <p className="access-denied-page__identity" aria-label="Logged in as">
            Logged in as: {windowsIdentity}
          </p>
        )}
      </div>
    </div>
  );
}
