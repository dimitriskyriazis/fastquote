'use client';

import { useState, useCallback } from 'react';
import OfferStatusHistoryModal from '../OfferStatusHistoryModal';

type Props = {
  offerId: string;
  className?: string;
};

export default function ViewStatusHistoryButton({ offerId, className }: Props) {
  const [modalOpen, setModalOpen] = useState(false);

  const handleClick = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setModalOpen(false);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={className}
      >
        View Status History
      </button>
      <OfferStatusHistoryModal
        open={modalOpen}
        offerId={offerId}
        onClose={handleClose}
      />
    </>
  );
}
