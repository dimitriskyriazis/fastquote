import styles from './Skeleton.module.css';

type SkeletonProps = {
  width?: number | string;
  height?: number | string;
  variant?: 'rect' | 'text' | 'circle';
  className?: string;
};

export default function Skeleton({
  width,
  height = 16,
  variant = 'rect',
  className,
}: SkeletonProps) {
  const variantClass = variant === 'text' ? styles.text : variant === 'circle' ? styles.circle : '';
  const classes = [styles.skeleton, variantClass, className].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/** Skeleton for a grid/list page (header bar + rows). */
export function GridPageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className={styles.gridPage}>
      <div className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <Skeleton width={160} height={32} />
          <Skeleton width={200} height={32} />
        </div>
        <div className={styles.headerRight}>
          <Skeleton width={90} height={32} />
          <Skeleton width={90} height={32} />
        </div>
      </div>
      <div className={styles.gridContainer}>
        <div className={styles.gridHeaderRow}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={14} className={styles.gridCell} variant="text" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={styles.gridRow}>
            {Array.from({ length: 5 }, (_, j) => (
              <Skeleton key={j} height={12} className={styles.gridCell} variant="text" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Skeleton for a detail/form page (header + form sections). */
export function DetailPageSkeleton() {
  return (
    <div className={styles.detailPage}>
      <div className={styles.headerRow}>
        <Skeleton width={240} height={32} />
        <div className={styles.headerRight}>
          <Skeleton width={90} height={32} />
        </div>
      </div>
      <div className={styles.formSection}>
        <Skeleton width={120} height={18} variant="text" />
        <div className={styles.formRow}>
          <div className={styles.formField}>
            <Skeleton width={80} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
          <div className={styles.formField}>
            <Skeleton width={100} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
          <div className={styles.formField}>
            <Skeleton width={70} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
        </div>
        <div className={styles.formRow}>
          <div className={styles.formField}>
            <Skeleton width={90} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
          <div className={styles.formField}>
            <Skeleton width={110} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
        </div>
      </div>
      <div className={styles.formSection}>
        <Skeleton width={140} height={18} variant="text" />
        <div className={styles.formRow}>
          <div className={styles.formField}>
            <Skeleton width={60} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
          <div className={styles.formField}>
            <Skeleton width={100} height={12} variant="text" />
            <Skeleton height={36} />
          </div>
        </div>
      </div>
    </div>
  );
}
