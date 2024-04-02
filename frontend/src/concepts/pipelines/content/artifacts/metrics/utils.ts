import { Artifact, ArtifactType } from '~/third_party/mlmd';
import { ConfidenceMetric, PlotType, ROCCurveConfig } from './types';

export const mlmdDisplayName = (id: string, mlmdTypeStr: string, displayName?: string): string =>
  displayName || `${mlmdTypeStr} ID #${id}`;

export const getClassificationMetricsArtifacts = (
  artifacts: Artifact[],
  artifactTypes: ArtifactType[],
): Artifact[] => {
  // Reference: https://github.com/kubeflow/pipelines/blob/master/sdk/python/kfp/dsl/io_types.py#L124
  // system.ClassificationMetrics contains confusionMatrix or confidenceMetrics.
  const classificationMetricsArtifacts = filterArtifactsByType(
    'system.ClassificationMetrics',
    artifactTypes,
    artifacts,
  );

  return classificationMetricsArtifacts
    .map((artifact) => ({
      name: artifact.getCustomPropertiesMap().get('display_name')?.getStringValue(),
      customProperties: artifact.getCustomPropertiesMap(),
      artifact,
    }))
    .filter((x) => !!x.name)
    .filter((x) => {
      const confidenceMetrics = x.customProperties
        .get('confidenceMetrics')
        ?.getStructValue()
        ?.toJavaScript();

      const confusionMatrix = x.customProperties
        .get('confusionMatrix')
        ?.getStructValue()
        ?.toJavaScript();
      return !!confidenceMetrics || !!confusionMatrix;
    })
    .map((x) => x.artifact);
};

export const getMetricsArtifacts = (
  artifacts: Artifact[],
  artifactTypes: ArtifactType[],
): Artifact[] => {
  // Reference: https://github.com/kubeflow/pipelines/blob/master/sdk/python/kfp/dsl/io_types.py#L104
  // system.Metrics contains scalar metrics.
  const metricsArtifacts = filterArtifactsByType('system.Metrics', artifactTypes, artifacts);

  return metricsArtifacts.filter((x) =>
    x.getCustomPropertiesMap().get('display_name')?.getStringValue(),
  );
};

export function buildRocCurveConfig(artifact: Artifact): ROCCurveConfig {
  const confidenceMetric = artifact
    .getCustomPropertiesMap()
    .get('confidenceMetrics')
    ?.getStructValue()
    ?.toJavaScript();

  const data =
    confidenceMetric && confidenceMetric.list ? (confidenceMetric.list as ConfidenceMetric[]) : [];

  return {
    type: PlotType.ROC,
    data: data.map((metric) => ({
      name: metric.confidenceThreshold,
      x: metric.falsePositiveRate,
      y: metric.recall,
    })),
  };
}

export const getMarkdownArtifacts = (
  artifacts: Artifact[],
  artifactTypes: ArtifactType[],
): Artifact[] => {
  const htmlArtifacts = filterArtifactsByType('system.Markdown', artifactTypes, artifacts);

  return htmlArtifacts.filter((x) =>
    x.getCustomPropertiesMap().get('display_name')?.getStringValue(),
  );
};

export const filterArtifactsByType = (
  artifactTypeName: string,
  artifactTypes: ArtifactType[],
  artifacts: Artifact[],
): Artifact[] => {
  const artifactTypeIds = artifactTypes
    .filter((artifactType) => artifactType.getName() === artifactTypeName)
    .map((artifactType) => artifactType.getId());
  return artifacts.filter((artifact) => artifactTypeIds.includes(artifact.getTypeId()));
};
