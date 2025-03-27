import React from 'react';
import { Form, Button, FormSection } from '@patternfly/react-core';
import { z } from 'zod';
import { useValidation } from '~/utilities/useValidation';
import useGenericObjectState from '~/utilities/useGenericObjectState';
import { personalInfoSchema, PersonalInfoSection } from './PersonalInfoSection';

const userFormSchema = z.object({
  personal: personalInfoSchema,
  location: locationInfoSchema,
});

type UserFormData = z.infer<typeof userFormSchema>;

const defaultFormData: UserFormData = {
  personal: {
    name: '',
    email: '',
  },
  location: {
    city: '',
    state: '',
    zip: '',
  },
};

export const ValidationExample = (): React.JSX.Element => {
  const [formData, setFormDataProp] = useGenericObjectState<UserFormData>(defaultFormData);
  const { validationResult } = useValidation(formData, userFormSchema);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validationResult.success) {
      // submit form
    }
  };

  return (
    <Form onSubmit={handleSubmit}>
      <FormSection title="Personal Information">
        <PersonalInfoSection
          data={formData.personal}
          setData={(data) => {
            setFormDataProp('personal', data);
          }}
        />
        <LocationInfoSection
          data={formData.location}
          setData={(data) => {
            setFormDataProp('location', data);
          }}
        />
      </FormSection>

      <Button type="submit" variant="primary" isDisabled={!validationResult.success}>
        Submit
      </Button>
    </Form>
  );
};
