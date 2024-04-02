import React from 'react';
import { Context } from '~/third_party/mlmd';
import { usePipelinesAPI } from '~/concepts/pipelines/context';
import useFetchState, {
  FetchState,
  FetchStateCallbackPromise,
  NotReadyError,
} from '~/utilities/useFetchState';
import { GetContextByTypeAndNameRequest } from '~/third_party/mlmd/generated/ml_metadata/proto/metadata_store_service_pb';

const KFP_V2_RUN_CONTEXT_TYPE = 'system.PipelineRun';

const useMlmdContext = (name?: string, type?: string): FetchState<Context | null> => {
  const { metadataStoreServiceClient } = usePipelinesAPI();

  const call = React.useCallback<FetchStateCallbackPromise<Context | null>>(async () => {
    if (!type) {
      return Promise.reject(new NotReadyError('No context type'));
    }
    if (!name) {
      return Promise.reject(new NotReadyError('No context name'));
    }

    const request = new GetContextByTypeAndNameRequest();
    request.setTypeName(type);
    request.setContextName(name);
    const res = await metadataStoreServiceClient.getContextByTypeAndName(request);
    const context = res.getContext();
    if (!context) {
      return Promise.reject(new Error('Cannot find specified context'));
    }
    return context;
  }, [metadataStoreServiceClient, type, name]);

  return useFetchState(call, null);
};

export const usePipelineRunMlmdContext = (runID?: string): FetchState<Context | null> =>
  useMlmdContext(runID, KFP_V2_RUN_CONTEXT_TYPE);
