export enum PlotType {
  CONFUSION_MATRIX = 'confusion_matrix',
  MARKDOWN = 'markdown',
  ROC = 'roc',
  TABLE = 'table',
  TENSORBOARD = 'tensorboard',
  VISUALIZATION_CREATOR = 'visualization-creator',
  WEB_APP = 'web-app',
}

export interface ViewerConfig {
  type: PlotType;
}

export interface ConfusionMatrixConfig extends ViewerConfig {
  data: number[][];
  labels: string[];
  type: PlotType;
}

export interface ROCCurveConfig extends ViewerConfig {
  data: {
    name: string;
    x: number;
    y: number;
  }[];
}

export type ConfidenceMetric = {
  confidenceThreshold: string;
  falsePositiveRate: number;
  recall: number;
};
