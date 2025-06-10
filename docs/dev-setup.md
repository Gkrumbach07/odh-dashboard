# Dev Setup

## Requirements

ODH requires the following to run:

- [NodeJS and NPM](https://nodejs.org/)
  - Node recommended version -> `20.18.0`
  - NPM recommended version -> `10.8.2`
- [OpenShift CLI](https://docs.redhat.com/en/documentation/openshift_container_platform/4.16/html/cli_tools/openshift-cli-oc)
- [kustomize](https://github.com/kubernetes-sigs/kustomize) (if you need to do deployment)

### Additional tooling

- [Podman](https://github.com/containers/podman)
- [Quay.io](https://quay.io/)

## Development

1. Clone the repository
   ```bash
   git clone https://github.com/opendatahub-io/odh-dashboard
   ```
2. Within the repo context, we use `npm` to install project dependencies
   ```bash
   cd odh-dashboard && npm install
   ```

### Build project

```bash
npm run build
```

### Serve development content

This is the default context for running a local UI. Make sure you build the project using the instructions above prior to running the command below.

> Note: You must be logged-in with `oc` before you can start the backend. Details for that are in the the [contribution guidelines](../CONTRIBUTING.md#give-your-dev-env-access).

> Note: The CLI logged-in user will need to be a `cluster-admin` level user on the cluster to mimic the Dashboard Service Account level of permissions. You could also bind the [cluster role](../manifests/core-bases/base/cluster-role.yaml) to your user as we do with the service account [binding](../manifests/core-bases/base/cluster-role-binding.yaml).

```bash
npm run start
```

> If you'd like to run "backend" and "frontend" separately for development, cd into each directory in two different terminals and run `npm run start:dev` from each.

For in-depth local run guidance review the [contribution guidelines](../CONTRIBUTING.md).

### Testing
Run the tests.

```bash
npm run test
```

For in-depth testing guidance review the [testing guidelines](./testing.md)

### Dev Feature Flags

Feature flags are defined in the [dashboard config](./dashboard-config.md#features). When testing on a live cluster, changing feature flags via the config affects all users on the cluster. It is also possible to personally control the enablement of feature flags within the browser session. Simply append `?devFeatureFlags` to the dashboard URL. A blue banner will appear at the top of the page where a modal can be opened, allowing one to adjust the enablement of feature flags. These settings will persist for the length of the browser session.

With the dev feature flags modal opened, the browser URL will update to include the current feature flag enablement settings. The URL can then be bookmarked or shared.

### Configuring Custom Console Link Domain (CONSOLE_LINK_DOMAIN)

Certain environments require custom access configurations for the OpenShift console and Prometheus endpoints because they may not have access to internal services. To support these configurations, the CONSOLE_LINK_DOMAIN environment variable allows developers to specify a custom domain to override default calculations.

Steps to Configure:

1.  Open the root `.env.local` file (or create it if it doesn't exist).
2.  Add the following line to define the custom console domain:

    <code>CONSOLE_LINK_DOMAIN=your-custom-domain.com</code>

Replace your-custom-domain.com with the specific domain for your OpenShift console

## Setting Up Specific Dashboard Areas for Development

The dashboard contains multiple areas that can be individually enabled/disabled via feature flags and component configurations. Each area may have dependencies on other areas, specific OpenShift operators, or cluster capabilities. This section provides detailed setup instructions for each area.

### Prerequisites for All Area Setups

- OpenShift cluster with cluster-admin access
- OpenShift CLI (`oc`) installed and authenticated
- Dashboard development environment set up (see above sections)

### Data Science Pipelines

**Feature Flag:** `disablePipelines` (set to `false` to enable)  
**Required Components:** `data-science-pipelines-operator`  
**Dependencies:** None

#### Setup Instructions

1. **Install OpenShift Pipelines Operator**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: openshift-pipelines-operator
     namespace: openshift-operators
   spec:
     channel: pipelines-1.10
     name: openshift-pipelines-operator-rh
     source: redhat-operators
     sourceNamespace: openshift-marketplace
   EOF
   ```

2. **Install Data Science Pipelines Operator**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: data-science-pipelines-operator
     namespace: openshift-operators
   spec:
     channel: stable
     name: data-science-pipelines-operator
     source: community-operators
     sourceNamespace: openshift-marketplace
   EOF
   ```

3. **Create a Data Science Project and Pipeline Server**
   ```bash
   # Create a test project
   oc new-project test-ds-pipelines
   
   # Create a DataSciencePipelinesApplication
   oc apply -f - <<EOF
   apiVersion: datasciencepipelinesapplications.opendatahub.io/v1
   kind: DataSciencePipelinesApplication
   metadata:
     name: sample-pipeline
     namespace: test-ds-pipelines
   spec:
     objectStorage:
       minio:
         deploy: true
         image: 'quay.io/opendatahub/minio:RELEASE.2019-08-14T20-37-41Z-license-compliance'
     database:
       mariaDB:
         deploy: true
   EOF
   ```

4. **Enable Feature Flag**
   - Via dev flags modal: Set `disablePipelines = false`
   - Via DSC config: Ensure `datasciencepipelines.managementState = Managed`

#### Verification
- Navigate to Data Science Projects → Create pipeline
- Verify pipeline server is visible and functional
- Check that pipeline imports work correctly

---

### KServe (Single Model Serving)

**Feature Flag:** `disableKServe` (set to `false` to enable)  
**Required Components:** `kserve`  
**Dependencies:** OpenShift Serverless, Service Mesh

#### Setup Instructions

1. **Install OpenShift Serverless Operator**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: serverless-operator
     namespace: openshift-serverless
   spec:
     channel: stable
     name: serverless-operator
     source: redhat-operators
     sourceNamespace: openshift-marketplace
   EOF
   ```

2. **Create Knative Serving Instance**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operator.knative.dev/v1beta1
   kind: KnativeServing
   metadata:
     name: knative-serving
     namespace: knative-serving
   spec: {}
   EOF
   ```

3. **Install Service Mesh Operator**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: servicemeshoperator
     namespace: openshift-operators
   spec:
     channel: stable
     name: servicemeshoperator
     source: redhat-operators
     sourceNamespace: openshift-marketplace
   EOF
   ```

4. **Create Service Mesh Instance**
   ```bash
   oc apply -f - <<EOF
   apiVersion: maistra.io/v2
   kind: ServiceMeshControlPlane
   metadata:
     name: data-science-smcp
     namespace: istio-system
   spec:
     version: v2.4
     tracing:
       type: Jaeger
       sampling: 10000
     addons:
       jaeger:
         name: jaeger
       kiali:
         enabled: true
         name: kiali
       grafana:
         enabled: true
   EOF
   ```

5. **Enable KServe Component**
   ```bash
   oc patch datasciencecluster default-dsc --type='merge' -p='{"spec":{"components":{"kserve":{"managementState":"Managed"}}}}'
   ```

#### Verification
- Check Model Serving page appears in dashboard
- Verify ability to deploy a test model
- Confirm KServe resources are created properly

---

### Model Registry

**Feature Flag:** `disableModelRegistry` (set to `false` to enable)  
**Required Components:** `model-registry-operator`  
**Required Capabilities:** Service Mesh, Service Mesh Authorization  
**Dependencies:** KServe setup (above)

#### Setup Instructions

1. **Install Authorino Operator**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: authorino-operator
     namespace: openshift-operators
   spec:
     channel: stable
     name: authorino-operator
     source: community-operators
     sourceNamespace: openshift-marketplace
   EOF
   ```

2. **Enable Model Registry Component**
   ```bash
   oc patch datasciencecluster default-dsc --type='merge' -p='{"spec":{"components":{"modelregistry":{"managementState":"Managed"}}}}'
   ```

3. **Verify Service Mesh Authorization is Enabled**
   ```bash
   oc patch dscinitialization default-dsci --type='merge' -p='{"spec":{"serviceMesh":{"auth":{"audiences":["https://kubernetes.default.svc"]}}}}'
   ```

#### Verification
- Model Registry option appears in dashboard navigation
- Can create and view model registrations
- Model versions can be registered and retrieved

---

### Distributed Workloads

**Feature Flag:** `disableDistributedWorkloads` (set to `false` to enable)  
**Required Components:** `kueue`  
**Dependencies:** None

#### Setup Instructions

1. **Enable Kueue Component**
   ```bash
   oc patch datasciencecluster default-dsc --type='merge' -p='{"spec":{"components":{"kueue":{"managementState":"Managed"}}}}'
   ```

2. **Enable CodeFlare Component**
   ```bash
   oc patch datasciencecluster default-dsc --type='merge' -p='{"spec":{"components":{"codeflare":{"managementState":"Managed"}}}}'
   ```

#### Verification
- Distributed Workloads section appears in project details
- Can create and submit distributed training jobs
- Job queues and resource quotas are manageable

---

### Workbenches

**Required Components:** `workbenches`  
**Dependencies:** Data Science Projects enabled

#### Setup Instructions

1. **Enable Workbenches Component**
   ```bash
   oc patch datasciencecluster default-dsc --type='merge' -p='{"spec":{"components":{"workbenches":{"managementState":"Managed"}}}}'
   ```

2. **Ensure Notebook Images are Available**
   ```bash
   # Check available notebook images
   oc get imagestreams -n redhat-ods-applications
   ```

#### Verification
- Workbenches tab appears in data science projects
- Can create and start notebook servers
- JupyterLab interface is accessible

---

### TrustyAI (Bias Metrics)

**Feature Flag:** `disableTrustyBiasMetrics` (set to `false` to enable)  
**Required Components:** `trustyai`  
**Dependencies:** Model Serving enabled

#### Setup Instructions

1. **Enable TrustyAI Component**
   ```bash
   oc patch datasciencecluster default-dsc --type='merge' -p='{"spec":{"components":{"trustyai":{"managementState":"Managed"}}}}'
   ```

#### Verification
- Bias metrics options appear in model serving interfaces
- TrustyAI service pods are running
- Bias detection jobs can be configured

---

### Accelerator Profiles

**Feature Flag:** `disableAcceleratorProfiles` (set to `false` to enable)  
**Dependencies:** None (but GPU operators recommended for full functionality)

#### Setup Instructions

1. **Enable Feature Flag**
   - Via dev flags modal: Set `disableAcceleratorProfiles = false`

2. **Optional: Install NVIDIA GPU Operator for Real GPU Support**
   ```bash
   oc apply -f - <<EOF
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: gpu-operator-certified
     namespace: openshift-operators
   spec:
     channel: stable
     name: gpu-operator-certified
     source: certified-operators
     sourceNamespace: openshift-marketplace
   EOF
   ```

#### Verification
- Accelerator profiles management appears in Settings
- Can create and modify accelerator profiles
- Profiles are selectable in workbench creation

---

### Storage Classes

**Feature Flag:** `disableStorageClasses` (set to `false` to enable)  
**Dependencies:** None

#### Setup Instructions

1. **Enable Feature Flag**
   - Via dev flags modal: Set `disableStorageClasses = false`

#### Verification
- Storage classes management appears in Settings
- Can view and modify storage class configurations
- Storage classes are available for PVC creation

---

### Model Serving Runtime Parameters

**Feature Flag:** `disableServingRuntimeParams` (set to `false` to enable)  
**Dependencies:** KServe and Model Serving enabled

#### Setup Instructions

1. **Ensure KServe is Setup** (see KServe section above)

2. **Enable Feature Flag**
   - Via dev flags modal: Set `disableServingRuntimeParams = false`

#### Verification
- Advanced serving runtime parameters are configurable
- Custom runtime parameters can be set during model deployment
- Runtime configurations are persistent

---

### User Management

**Feature Flag:** `disableUserManagement` (set to `false` to enable)  
**Dependencies:** Cluster admin permissions

#### Setup Instructions

1. **Enable Feature Flag**
   - Via dev flags modal: Set `disableUserManagement = false`

2. **Ensure Proper RBAC Setup**
   ```bash
   # Verify cluster role bindings exist
   oc get clusterrolebinding | grep odh
   ```

#### Verification
- User management appears in Settings
- Can view and manage user groups
- User access controls are functional

---

### Custom Serving Runtimes

**Feature Flag:** `disableCustomServingRuntimes` (set to `false` to enable)  
**Dependencies:** Model Serving enabled

#### Setup Instructions

1. **Ensure Model Serving is Setup**

2. **Enable Feature Flag**
   - Via dev flags modal: Set `disableCustomServingRuntimes = false`

#### Verification
- Custom serving runtimes management appears
- Can create and deploy custom serving runtime templates
- Custom runtimes are available for model deployment

---

## Quick Setup Scripts

For rapid development environment setup, here are some helper scripts:

### Enable All Core Features
```bash
#!/bin/bash
echo "Enabling all core OpenShift AI features..."

# Enable all core components
oc patch datasciencecluster default-dsc --type='merge' -p='{
  "spec": {
    "components": {
      "dashboard": {"managementState": "Managed"},
      "workbenches": {"managementState": "Managed"},
      "datasciencepipelines": {"managementState": "Managed"},
      "kserve": {"managementState": "Managed"},
      "modelmeshserving": {"managementState": "Managed"}
    }
  }
}'
```

### Create Test Data Science Project
```bash
#!/bin/bash
PROJECT_NAME="test-development"

oc new-project $PROJECT_NAME
oc label namespace $PROJECT_NAME opendatahub.io/dashboard=true

# Create a basic DSPA for pipelines
oc apply -f - <<EOF
apiVersion: datasciencepipelinesapplications.opendatahub.io/v1
kind: DataSciencePipelinesApplication
metadata:
  name: test-pipelines
  namespace: $PROJECT_NAME
spec:
  objectStorage:
    minio:
      deploy: true
      image: 'quay.io/opendatahub/minio:RELEASE.2019-08-14T20-37-41Z-license-compliance'
  database:
    mariaDB:
      deploy: true
EOF
```

## Troubleshooting Common Setup Issues

### Component Not Appearing in Dashboard
1. Check if feature flag is properly disabled: `disableX = false`
2. Verify component is managed: `managementState = Managed`
3. Check component pods are running: `oc get pods -n redhat-ods-applications`
4. Review operator logs: `oc logs -n redhat-ods-operator deployment/rhods-operator`

### KServe Setup Issues
1. Verify Serverless and Service Mesh operators are installed
2. Check Knative Serving is ready: `oc get knativeserving -A`
3. Verify Service Mesh control plane: `oc get smcp -A`
4. Review KServe controller logs: `oc logs -n redhat-ods-applications deployment/kserve-controller-manager`

### Pipeline Server Creation Fails
1. Ensure OpenShift Pipelines operator is installed
2. Check for sufficient cluster resources
3. Verify storage classes are available: `oc get storageclass`
4. Review DSPA status: `oc describe dspa -n <project>`

### Performance and Resource Considerations

When setting up multiple areas for development:

- **Minimum Resources**: 8 CPUs, 32GB RAM across worker nodes
- **Recommended**: 16 CPUs, 64GB RAM for full feature testing
- **Storage**: Fast SSD storage classes recommended for databases and object storage
- **Network**: Ensure proper ingress/egress rules for external integrations

This comprehensive setup guide should enable developers to configure and test individual dashboard areas effectively. Each section can be followed independently based on development needs.

## Deploying the ODH Dashbard

### Official Image Builds

odh-dashboard images are automatically built and pushed to [quay.io](https://quay.io/repository/opendatahub/odh-dashboard) after every commit to the `main` branch. The image tag name format for each image is `main-<COMMIT SHORT HASH>`.

Example: The `main` branch is updated with commit `f76e3952834f453b1d085e8627f9c17297c2f64c`. The CI system will automatically build an odh-dashboard image based on that code and push the new image to `odh-dashboard:main-f76e395` and updated `odh-dashboard:main` to point to the same image hash.

The [nightly](https://quay.io/opendatahub/odh-dashboard:nightly) tag is a floating tag that is updated nightly and points to the most recent `main-<HASH>` commit from the previous day.

### Deploy using kustomize

The [manifests](../manifests) folder contains a [kustomize](https://kustomize.io) manifest that can be used with `kustomize build`.

### Deploy using a kfdef

> Note: This flow is deprecated, deploy v2 [Operator](https://github.com/opendatahub-io/opendatahub-operator) with their custom CR.

The [manifests/kfdef](../manifests/kfdef) folder contains an example kfdef to deploy ODH Dashboard with the Notebook Controller backend is located in [odh-dashboard-kfnbc-test.yaml](../manifests/kfdef/odh-dashboard-kfnbc-test.yaml).
