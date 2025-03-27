import { useState } from 'react';
import { ZodIssue, ZodType } from 'zod';
import { useValidation } from '~/utilities/useValidation';

export function useZodFormValidation<T>(
  data: T,
  schema: ZodType<T>,
): {
  markFieldTouched: (fieldPath: (string | number)[]) => void;
  getFieldValidation: (fieldPath: (string | number)[]) => ZodIssue[];
} {
  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>({});
  const { getAllValidationIssues } = useValidation(data, schema);

  const markFieldTouched = (fieldPath: (string | number)[]) => {
    const key = fieldPath.join('.');
    setTouchedFields((prev) => ({ ...prev, [key]: true }));
  };

  const getFieldValidation = (fieldPath: (string | number)[]): ZodIssue[] => {
    const key = fieldPath.join('.');
    const issues = getAllValidationIssues(fieldPath);
    if (touchedFields[key] && issues.length) {
      return issues;
    }
    return [];
  };

  return { markFieldTouched, getFieldValidation };
}
