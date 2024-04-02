import { Chart, ChartVoronoiContainer, ChartAxis, ChartLine } from '@patternfly/react-charts';
import React from 'react';
import { ROCCurveConfig } from './types';

type ROCCurveProps = {
  configs: ROCCurveConfig[];
  maxDimension?: number;
};

const ROCCurve: React.FC<ROCCurveProps> = ({ configs, maxDimension }) => {
  const width = maxDimension || 800;
  const height = width;
  const datasets = configs.map((config) => config.data);
  const baseLineData = Array.from(Array(100).keys()).map((x) => ({ x: x / 100, y: x / 100 }));

  return (
    <div style={{ height, width, borderStyle: 'solid', borderWidth: 1 }}>
      <Chart
        ariaDesc="ROC Curve"
        ariaTitle="ROC Curve"
        containerComponent={
          <ChartVoronoiContainer
            labels={({ datum }) => `Threshold: ${datum.name}`}
            constrainToVisibleArea
            voronoiBlacklist={['baseline']}
          />
        }
        height={height}
        width={width}
        padding={75}
      >
        <ChartAxis dependentAxis label="True positive rate" />
        <ChartAxis label="False positive rate" />
        <ChartLine
          name="baseline"
          data={baseLineData}
          style={{
            data: {
              strokeDasharray: '3,3',
            },
          }}
        />
        {datasets.map((data, idx) => (
          <ChartLine key={idx} data={data} interpolation="basis" />
        ))}
      </Chart>
    </div>
  );
};

export default ROCCurve;
