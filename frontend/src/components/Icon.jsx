import React from 'react';

export const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">
    {children}
  </span>
);
