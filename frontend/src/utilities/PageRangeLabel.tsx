import * as React from 'react';

type PageRangeLabelProps = {
  page: number;
  lastPage: number;
};

const PageRangeLabel: React.FC<PageRangeLabelProps> = ({ page, lastPage }) => (
  <span style={{ color: '#6a6e73', marginLeft: '8px', fontSize: '14px' }}>
    Page {page} of {lastPage}
  </span>
);

export default PageRangeLabel;
