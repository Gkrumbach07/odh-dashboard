/* eslint-disable no-irregular-whitespace */
/**
 * Mocked response for GetEventsByExecutionIDs
 * @returns
 * {
    "eventsList": [
        {
            "artifactId": 7,
            "executionId": 288,
            "path": {
                "stepsList": [
                    {
                        "key": "metrics"
                    }
                ]
            },
            "type": 4,
            "millisecondsSinceEpoch": 1712899529364
        },
        {
            "artifactId": 17,
            "executionId": 289,
            "path": {
                "stepsList": [
                    {
                        "key": "html_artifact"
                    }
                ]
            },
            "type": 4,
            "millisecondsSinceEpoch": 1712899529740
        },
        {
            "artifactId": 9,
            "executionId": 290,
            "path": {
                "stepsList": [
                    {
                        "key": "metrics"
                    }
                ]
            },
            "type": 4,
            "millisecondsSinceEpoch": 1712899529842
        },
        {
            "artifactId": 8,
            "executionId": 291,
            "path": {
                "stepsList": [
                    {
                        "key": "metrics"
                    }
                ]
            },
            "type": 4,
            "millisecondsSinceEpoch": 1712899530048
        },
        {
            "artifactId": 16,
            "executionId": 292,
            "path": {
                "stepsList": [
                    {
                        "key": "markdown_artifact"
                    }
                ]
            },
            "type": 4,
            "millisecondsSinceEpoch": 1712899531648
        }
    ]
}
 */
export const mockGetEventsByExecutionIDs = (): string => `
    �
�
	metrics (�����1
!�

html_artifact (�����1
	�
	metrics (򸒆�1
�
	metrics (�����1
%�
markdown_artifact (�ǒ��1�   grpc-status:0

`;
