import React from 'react';
import { NotebookKind, PersistentVolumeClaimKind } from '#~/k8sTypes';
import { getNotebookPVCMountPathMap } from '#~/pages/projects/notebook/utils';
import { ClusterStorageNotebookSelection } from '#~/pages/projects/types';

const useClusterStorageFormState = (
  connectedNotebooks: NotebookKind[],
  existingPvc?: PersistentVolumeClaimKind,
): {
  notebookData: ClusterStorageNotebookSelection[];
  setNotebookData: React.Dispatch<React.SetStateAction<ClusterStorageNotebookSelection[]>>;
} => {
  const [notebookData, setNotebookData] = React.useState<ClusterStorageNotebookSelection[]>([]);

  React.useEffect(() => {
    const connectedNotebookNames = new Set(
      connectedNotebooks.map((connectedNotebook) => connectedNotebook.metadata.name),
    );

    if (connectedNotebooks.length === 0) {
      setNotebookData((prev) => prev.filter((notebook) => !notebook.existingPvc));
      return;
    }

    setNotebookData((prev) => {
      const connectedNotebookData = connectedNotebooks.map((connectedNotebook) => {
        const notebookName = connectedNotebook.metadata.name;
        const existingEntry = prev.find((notebook) => notebook.name === notebookName);
        const defaultMountPath = existingPvc
          ? getNotebookPVCMountPathMap(connectedNotebook)[existingPvc.metadata.name] ?? ''
          : '';

        return {
          name: notebookName,
          notebookDisplayName:
            connectedNotebook.metadata.annotations?.['openshift.io/display-name'],
          mountPath: existingEntry
            ? existingEntry.mountPath
            : { value: defaultMountPath, error: '' },
          existingPvc: true,
          isUpdatedValue: existingEntry?.isUpdatedValue ?? false,
        };
      });

      const additionalNotebookData = prev.filter(
        (notebook) => !connectedNotebookNames.has(notebook.name) || !notebook.existingPvc,
      );

      return [...connectedNotebookData, ...additionalNotebookData];
    });
  }, [connectedNotebooks, existingPvc]);

  return { notebookData, setNotebookData };
};

export default useClusterStorageFormState;
