'use client';

import React, { type CSSProperties } from 'react';

type Props = {
  oID: string;
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: '#0f172a',
};

export default function OfferBasicDataPanel({}: Props) {
  return (
    <div>
      <h2 style={sectionTitleStyle}>Basic Data</h2>
    </div>
  );
}
