import React from 'react';
import { Artifact, Context } from '~/third_party/mlmd';
import { usePipelinesAPI } from '~/concepts/pipelines/context';
import useFetchState, {
  FetchState,
  FetchStateCallbackPromise,
  NotReadyError,
} from '~/utilities/useFetchState';
import { GetArtifactsByContextRequest } from '~/third_party/mlmd/generated/ml_metadata/proto/metadata_store_service_pb';

export const useArtifactsByContext = (context?: Context | null): FetchState<Artifact[]> => {
  const { metadataStoreServiceClient } = usePipelinesAPI();

  const call = React.useCallback<FetchStateCallbackPromise<Artifact[]>>(async () => {
    if (!context) {
      return Promise.reject(new NotReadyError('No context'));
    }
    const request = new GetArtifactsByContextRequest();
    request.setContextId(context.getId());
    const res = await metadataStoreServiceClient.getArtifactsByContext(request);
    const list = res.getArtifactsList();
    if (list == null) {
      throw new Error('response.getExecutionsList() is empty');
    }
    // Display name of artifact exists in getCustomPropertiesMap().get('display_name').getStringValue().
    // Note that the actual artifact name is in Event which generates this artifact.
    return list;
  }, [context, metadataStoreServiceClient]);

  return useFetchState(call, []);
};
