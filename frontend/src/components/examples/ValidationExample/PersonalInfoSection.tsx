import React from 'react';
import { FormGroup, TextInput } from '@patternfly/react-core';
import { z } from 'zod';
import { useZodFormValidation } from '~/hooks/useZodFormValidation';
import { ZodErrorHelperText } from '~/components/ZodErrorFormHelperText';

export const personalInfoSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
});

export type PersonalInfoData = z.infer<typeof personalInfoSchema>;

type PersonalInfoSectionProps = {
  data: PersonalInfoData;
  setData: (data: PersonalInfoData) => void;
};

export const PersonalInfoSection = ({
  data,
  setData,
}: PersonalInfoSectionProps): React.JSX.Element => {
  const { getFieldValidation, markFieldTouched } = useZodFormValidation(data, personalInfoSchema);

  return (
    <>
      <FormGroup label="Name" isRequired>
        <TextInput
          value={data.name}
          onChange={(_e, value) => setData({ ...data, name: value })}
          onBlur={() => markFieldTouched(['name'])}
          validated={getFieldValidation(['name']).length > 0 ? 'error' : 'default'}
        />
        <ZodErrorHelperText zodIssue={getFieldValidation(['name'])} />
      </FormGroup>

      <FormGroup label="Email" isRequired>
        <TextInput
          type="email"
          value={data.email}
          onChange={(_e, value) => setData({ ...data, email: value })}
          onBlur={() => markFieldTouched(['email'])}
          validated={getFieldValidation(['email']).length > 0 ? 'error' : 'default'}
        />
        <ZodErrorHelperText zodIssue={getFieldValidation(['email'])} />
      </FormGroup>
    </>
  );
};
