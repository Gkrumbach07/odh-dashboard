import React from 'react';
import { ArtifactType } from '~/third_party/mlmd';
import { usePipelinesAPI } from '~/concepts/pipelines/context';
import useFetchState, { FetchState, FetchStateCallbackPromise } from '~/utilities/useFetchState';
import { GetArtifactTypeRequest } from '~/third_party/mlmd/generated/ml_metadata/proto/metadata_store_service_pb';

export const useArtifactTypes = (): FetchState<ArtifactType[]> => {
  const { metadataStoreServiceClient } = usePipelinesAPI();

  const call = React.useCallback<FetchStateCallbackPromise<ArtifactType[]>>(async () => {
    const request = new GetArtifactTypeRequest();
    const res = await metadataStoreServiceClient.getArtifactTypes(request);
    return res.getArtifactTypesList();
  }, [metadataStoreServiceClient]);

  return useFetchState(call, []);
};
