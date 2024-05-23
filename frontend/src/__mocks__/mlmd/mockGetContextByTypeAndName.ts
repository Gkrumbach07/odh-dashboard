/* eslint-disable no-irregular-whitespace */

/**
 * Mocks the response of the `getContextByTypeAndName` MLMD query.
 * @param id The id of the pipeline run to mock
 * @returns
{
    "context": {
        "id": 106,
        "name": "${name}",
        "typeId": 11,
        "type": "system.PipelineRun",
        "propertiesMap": [],
        "customPropertiesMap": [
            [
                "bucket_session_info",
                {
                    "stringValue": "{\"Region\":\"us-east-1\",\"Endpoint\":\"https://s3.amazonaws.com\",\"DisableSSL\":false,\"SecretName\":\"secret-3t3ar6\",\"AccessKeyKey\":\"AWS_ACCESS_KEY_ID\",\"SecretKeyKey\":\"AWS_SECRET_ACCESS_KEY\"}"
                }
            ],
            [
                "namespace",
                {
                    "stringValue": "jps-fun-world"
                }
            ],
            [
                "pipeline_root",
                {
                    "stringValue": "s3://aballant-pipelines/metrics-visualization-pipeline/${name}"
                }
            ],
            [
                "resource_name",
                {
                    "stringValue": "run-resource"
                }
            ]
        ],
        "createTimeSinceEpoch": 1712899519123,
        "lastUpdateTimeSinceEpoch": 1712899519123
    }
}
 */
export const mockGetContextByTypeAndName = (runId: string): string => `   �
�j$${runId}*n

pipeline_root][s3://aballant-pipelines/metrics-visualization-pipeline/${runId}*
	namespace
jps-fun-world*�
bucket_session_info��{"Region":"us-east-1","Endpoint":"https://s3.amazonaws.com","DisableSSL":false,"SecretName":"secret-3t3ar6","AccessKeyKey":"AWS_ACCESS_KEY_ID","SecretKeyKey":"AWS_SECRET_ACCESS_KEY"}*

resource_namerun-resource2system.PipelineRun8�呆�1@�呆�1�   grpc-status:0
`;
