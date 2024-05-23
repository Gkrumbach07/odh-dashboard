// import { TextEncoder } from 'util';
import { ArtifactType, GetArtifactTypesResponse } from '~/third_party/mlmd';
import { GrpcResponse } from './utils';

const mockedArtifactTypesResponse = {
  artifactTypesList: [
    {
      id: 14,
      name: 'system.Artifact',
      propertiesMap: [],
    },
    {
      id: 15,
      name: 'system.Dataset',
      propertiesMap: [],
    },
    {
      id: 16,
      name: 'system.Model',
      propertiesMap: [],
    },
    {
      id: 17,
      name: 'system.Metrics',
      propertiesMap: [],
    },
    {
      id: 18,
      name: 'system.ClassificationMetrics',
      propertiesMap: [],
    },
    {
      id: 19,
      name: 'system.Markdown',
      propertiesMap: [],
    },
    {
      id: 20,
      name: 'system.HTML',
      propertiesMap: [],
    },
  ],
};

export const mockGetArtifactTypes = (): GrpcResponse => {
  const artifactTypesResponse = new GetArtifactTypesResponse();
  const artifactTypesList = mockedArtifactTypesResponse.artifactTypesList.map((artifactType) => {
    const artifactTypeMessage = new ArtifactType();
    artifactTypeMessage.setId(artifactType.id);
    artifactTypeMessage.setName(artifactType.name);
    return artifactTypeMessage;
  });
  artifactTypesResponse.setArtifactTypesList(artifactTypesList);

  return createGrpcResponse(artifactTypesResponse);
};
