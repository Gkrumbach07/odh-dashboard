import React from 'react';
import { MlmdContextTypes } from '~/concepts/pipelines/apiHooks/mlmd/types';
import { getMlmdContext } from '~/concepts/pipelines/apiHooks/mlmd/useMlmdContext';
import { usePipelinesAPI } from '~/concepts/pipelines/context';
import { PipelineRunKFv2 } from '~/concepts/pipelines/kfTypes';
import useFetchState, {
  FetchState,
  FetchStateCallbackPromise,
  NotReadyError,
} from '~/utilities/useFetchState';
import { GetArtifactsByContextRequest } from '~/third_party/mlmd/generated/ml_metadata/proto/metadata_store_service_pb';
import { Artifact } from '~/third_party/mlmd';
import { useGetArtifactTypes } from '~/concepts/pipelines/apiHooks/mlmd/useGetArtifactTypes';
import { filterArtifactsByType } from './utils';
import { MetricsType } from './const';

const useScalarMetrics = (
  runs: PipelineRunKFv2[],
): FetchState<{ run: PipelineRunKFv2; artifacts: Artifact[] }[]> => {
  const { metadataStoreServiceClient } = usePipelinesAPI();
  const [artifactTypes, artifactTypesLoaded] = useGetArtifactTypes();

  const call = React.useCallback<
    FetchStateCallbackPromise<{ run: PipelineRunKFv2; artifacts: Artifact[] }[]>
  >(async () => {
    if (!artifactTypesLoaded) {
      return Promise.reject(new NotReadyError('No pod name'));
    }
    const start = performance.now();
    const times: number[] = [];
    const counts: number[] = [];
    const resp = await Promise.all(
      runs.map((run) =>
        getMlmdContext(metadataStoreServiceClient, run.run_id, MlmdContextTypes.RUN).then(
          async (context) => {
            if (!context) {
              throw new Error(`No context for run: ${run.run_id}`);
            }
            const innerStart = performance.now();
            // get artifacts
            const artifactRequest = new GetArtifactsByContextRequest();
            artifactRequest.setContextId(context.getId());
            const artifactRes = await metadataStoreServiceClient.getArtifactsByContext(
              artifactRequest,
            );
            const all = artifactRes.getArtifactsList();
            const artifacts = filterArtifactsByType(all, artifactTypes, MetricsType.SCALAR_METRICS);

            counts.push(all.length);
            times.push(performance.now() - innerStart);

            return {
              run,
              artifacts,
            };
          },
        ),
      ),
    );

    // eslint-disable-next-line no-console
    console.log(
      `total runs: ${runs.length}, total artifacts: ${counts.reduce(
        (a, b) => a + b,
        0,
      )}, average time: ${times.reduce((a, b) => a + b, 0) / times.length / 1000}s, total time: ${
        (performance.now() - start) / 1000
      }s`,
    );

    return resp;
  }, [metadataStoreServiceClient, runs, artifactTypes, artifactTypesLoaded]);

  return useFetchState(call, []);
};

export default useScalarMetrics;
