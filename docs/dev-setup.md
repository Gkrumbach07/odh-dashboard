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

The dashboard contains multiple areas that can be individually enabled/disabled via feature flags and component configurations. Each area may have dependencies on other areas, specific OpenShift operators, or cluster capabilities. This section provides detailed setup instructions for each area using the OpenShift Console UI.

### Prerequisites for All Area Setups

- OpenShift cluster with cluster-admin access
- Access to OpenShift Console web interface
- Dashboard development environment set up (see above sections)
- Understanding of OpenShift AI feature flags (accessible via `?devFeatureFlags` URL parameter)

### Data Science Pipelines

**Feature Flag:** `disablePipelines` (set to `false` to enable)  
**Required Components:** `data-science-pipelines-operator`  
**Dependencies:** None

#### Setup Instructions

1. **Install OpenShift Pipelines Operator via OperatorHub**
   - In OpenShift Console, navigate to **Operators** → **OperatorHub**
   - Search for "Red Hat OpenShift Pipelines"
   - Click on the operator tile
   - Click **Install**
   - Select **stable** channel
   - Choose **All namespaces on the cluster** installation mode
   - Click **Install** and wait for completion

2. **Install Data Science Pipelines Operator**
   - In OperatorHub, search for "Data Science Pipelines Operator"
   - Click on the operator tile
   - Click **Install**
   - Select **stable** channel
   - Choose **All namespaces on the cluster** installation mode
   - Click **Install** and wait for completion

3. **Enable Data Science Pipelines Component**
   - Navigate to **Operators** → **Installed Operators**
   - Click **Red Hat OpenShift AI**
   - Go to **Data Science Cluster** tab
   - Click on **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**
   - In the YAML editor, find the `datasciencepipelines` section under `spec.components`
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

4. **Create a Test Data Science Project**
   - Open the OpenShift AI Dashboard
   - Navigate to **Data Science Projects**
   - Click **Create data science project**
   - Enter project name: `test-ds-pipelines`
   - Add description: "Development testing for pipelines"
   - Click **Create**

5. **Configure Pipeline Server**
   - In your new project, scroll to **Pipelines** section
   - Click **Configure a pipeline server**
   - Configure Object Storage:
     - **Access key**: Enter a test access key
     - **Secret key**: Enter a test secret key  
     - **Endpoint**: `http://minio.example.com:9000` (or use built-in Minio)
     - **Bucket**: `test-pipelines`
   - Under **Database**, select **Use default database stored on your cluster**
   - Click **Configure**

6. **Enable Feature Flag**
   - Add `?devFeatureFlags` to your dashboard URL
   - Click the blue **Dev Feature Flags** banner
   - In the modal, set `disablePipelines` to `false`
   - Click **Save**

#### Verification
- **Pipelines** section appears in data science projects
- Can click **Import pipeline** button
- Pipeline server status shows as "Running"
- Can upload and view pipeline definitions

---

### KServe (Single Model Serving)

**Feature Flag:** `disableKServe` (set to `false` to enable)  
**Required Components:** `kserve`  
**Dependencies:** OpenShift Serverless, Service Mesh

#### Setup Instructions

1. **Install OpenShift Serverless Operator**
   - Navigate to **Operators** → **OperatorHub**
   - Search for "Red Hat OpenShift Serverless"
   - Click the operator tile
   - Click **Install**
   - Select **stable** channel
   - Choose **All namespaces on the cluster**
   - Click **Install**

2. **Create Knative Serving Instance**
   - After Serverless operator installs, go to **Operators** → **Installed Operators**
   - Click **Red Hat OpenShift Serverless**
   - Go to **Knative Serving** tab
   - Click **Create KnativeServing**
   - Accept default settings
   - Change **Name** to `knative-serving`
   - Click **Create**

3. **Install Service Mesh Operator**
   - In **OperatorHub**, search for "Red Hat OpenShift Service Mesh"
   - Click the operator tile
   - Click **Install**
   - Select **stable** channel
   - Choose **All namespaces on the cluster**
   - Click **Install**

4. **Create Service Mesh Control Plane**
   - Create namespace: **Workloads** → **Projects** → **Create Project**
   - Name: `istio-system`
   - Go to **Operators** → **Installed Operators**
   - Click **Red Hat OpenShift Service Mesh**
   - Go to **Istio Service Mesh Control Plane** tab
   - Click **Create ServiceMeshControlPlane**
   - In the form view:
     - **Name**: `data-science-smcp`
     - **Namespace**: `istio-system`
   - Switch to **YAML view** and ensure basic configuration
   - Click **Create**

5. **Enable KServe Component**
   - Navigate to **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - Go to **Data Science Cluster** tab → **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**
   - Find `kserve` section under `spec.components`
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

6. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableKServe` to `false`

#### Verification
- **Model Serving** appears in main navigation
- Can create new model servers in data science projects
- KServe controller pods running in `redhat-ods-applications` namespace
- Service Mesh control plane shows as "Ready"

---

### Model Registry

**Feature Flag:** `disableModelRegistry` (set to `false` to enable)  
**Required Components:** `model-registry-operator`  
**Required Capabilities:** Service Mesh, Service Mesh Authorization  
**Dependencies:** KServe setup (above)

#### Setup Instructions

1. **Install Authorino Operator**
   - Navigate to **OperatorHub**
   - Search for "Authorino"
   - Click **Authorino Operator**
   - Click **Install**
   - Select **stable** channel
   - Choose **All namespaces on the cluster**
   - Click **Install**

2. **Enable Model Registry Component**
   - Go to **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - **Data Science Cluster** tab → **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**
   - Find `modelregistry` section under `spec.components`
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

3. **Configure Service Mesh Authorization**
   - Go to **DSC Initialization** tab
   - Click **default-dsci**
   - Click **Actions** → **Edit DSCInitialization**
   - In YAML, find `serviceMesh` section
   - Add authorization configuration:
     ```yaml
     serviceMesh:
       managementState: Managed
       auth:
         audiences:
           - "https://kubernetes.default.svc"
     ```
   - Click **Save**

4. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableModelRegistry` to `false`

#### Verification
- **Model Registry** appears in navigation menu
- Can register models and view model versions
- Model registry pods running in applications namespace

---

### Distributed Workloads

**Feature Flag:** `disableDistributedWorkloads` (set to `false` to enable)  
**Required Components:** `kueue`, `codeflare`  
**Dependencies:** None

#### Setup Instructions

1. **Enable Kueue Component**
   - Navigate to **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - **Data Science Cluster** tab → **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**
   - Find `kueue` section under `spec.components`
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

2. **Enable CodeFlare Component**
   - In the same YAML editor, find `codeflare` section
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

3. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableDistributedWorkloads` to `false`

#### Verification
- **Distributed Workloads** section appears in project details
- Can create cluster queues and resource flavors
- Kueue and CodeFlare operator pods are running

---

### Workbenches

**Required Components:** `workbenches`  
**Dependencies:** Data Science Projects enabled

#### Setup Instructions

1. **Enable Workbenches Component**
   - Navigate to **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - **Data Science Cluster** tab → **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**
   - Find `workbenches` section under `spec.components`
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

2. **Verify Notebook Images**
   - Go to **Workloads** → **ImageStreams**
   - Filter by **Project**: `redhat-ods-applications`
   - Confirm notebook images are available (jupyter, pytorch, tensorflow, etc.)

#### Verification
- **Workbenches** tab appears in data science projects
- Can create new workbenches with various notebook images
- JupyterLab environment launches successfully

---

### TrustyAI (Bias Metrics)

**Feature Flag:** `disableTrustyBiasMetrics` (set to `false` to enable)  
**Required Components:** `trustyai`  
**Dependencies:** Model Serving enabled

#### Setup Instructions

1. **Enable TrustyAI Component**
   - Navigate to **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - **Data Science Cluster** tab → **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**
   - Find `trustyai` section under `spec.components`
   - Change `managementState: Removed` to `managementState: Managed`
   - Click **Save**

2. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableTrustyBiasMetrics` to `false`

#### Verification
- Bias metrics options appear in model serving interfaces
- TrustyAI service pods running in applications namespace

---

### Accelerator Profiles

**Feature Flag:** `disableAcceleratorProfiles` (set to `false` to enable)  
**Dependencies:** None (GPU operators recommended for full functionality)

#### Setup Instructions

1. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableAcceleratorProfiles` to `false`

2. **Optional: Install NVIDIA GPU Operator**
   - Navigate to **OperatorHub**
   - Search for "NVIDIA GPU Operator"
   - Click the operator tile
   - Click **Install**
   - Select **stable** channel
   - Choose **All namespaces on the cluster**
   - Click **Install**

#### Verification
- **Settings** → **Accelerator profiles** appears in dashboard
- Can create and modify accelerator profiles
- Profiles are available when creating workbenches

---

### Storage Classes

**Feature Flag:** `disableStorageClasses` (set to `false` to enable)  
**Dependencies:** None

#### Setup Instructions

1. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableStorageClasses` to `false`

#### Verification
- **Settings** → **Storage classes** appears in dashboard
- Can view and configure storage class settings
- Storage classes appear in PVC creation forms

---

### User Management

**Feature Flag:** `disableUserManagement` (set to `false` to enable)  
**Dependencies:** Cluster admin permissions

#### Setup Instructions

1. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableUserManagement` to `false`

2. **Verify RBAC Configuration**
   - Navigate to **User Management** → **RoleBindings**
   - Check that OpenShift AI role bindings exist
   - Verify cluster admin has proper permissions

#### Verification
- **Settings** → **User management** appears in dashboard
- Can view and manage user groups
- User access controls function properly

---

### Custom Serving Runtimes

**Feature Flag:** `disableCustomServingRuntimes` (set to `false` to enable)  
**Dependencies:** Model Serving enabled

#### Setup Instructions

1. **Ensure Model Serving is Enabled** (see KServe section above)

2. **Enable Feature Flag**
   - In dashboard with `?devFeatureFlags`, set `disableCustomServingRuntimes` to `false`

#### Verification
- **Settings** → **Serving runtimes** appears in dashboard
- Can create custom serving runtime templates
- Custom runtimes available for model deployment

---

## Quick Setup Guide via OpenShift Console

### Enable All Core Components at Once

1. **Navigate to Data Science Cluster Configuration**
   - **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - **Data Science Cluster** tab → **default-dsc**
   - Click **Actions** → **Edit DataScienceCluster**

2. **Update Component Management States**
   - In the YAML editor, change all desired components from `managementState: Removed` to `managementState: Managed`:
   ```yaml
   spec:
     components:
       dashboard:
         managementState: Managed
       workbenches:
         managementState: Managed
       datasciencepipelines:
         managementState: Managed
       kserve:
         managementState: Managed
       modelmeshserving:
         managementState: Managed
       modelregistry:
         managementState: Managed
       kueue:
         managementState: Managed
       codeflare:
         managementState: Managed
       trustyai:
         managementState: Managed
   ```
   - Click **Save**

3. **Enable Multiple Feature Flags**
   - In dashboard, add `?devFeatureFlags` to URL
   - Click the blue banner to open feature flags modal
   - Set multiple flags to `false` (which enables the features):
     - `disablePipelines = false`
     - `disableKServe = false`
     - `disableModelRegistry = false`
     - `disableDistributedWorkloads = false`
     - `disableAcceleratorProfiles = false`
     - And others as needed
   - Click **Save**

### Create Test Environment

1. **Create Development Project**
   - In OpenShift AI Dashboard: **Data Science Projects** → **Create data science project**
   - **Name**: `development-testing`
   - **Description**: "Development environment for testing all features"
   - Click **Create**

2. **Set Up Pipeline Server** (if pipelines enabled)
   - In project, **Pipelines** section → **Configure a pipeline server**
   - Use default database and configure minimal object storage
   - Click **Configure**

3. **Create Test Workbench** (if workbenches enabled)
   - **Workbenches** tab → **Create workbench**
   - **Name**: `test-notebook`
   - **Notebook image**: Standard Data Science
   - **Container size**: Small
   - Click **Create workbench**

## Troubleshooting UI Setup Issues

### Component Not Appearing in Dashboard
1. **Check Feature Flag Status**
   - Add `?devFeatureFlags` to dashboard URL
   - Verify the relevant `disableX` flag is set to `false`
   - Save changes and refresh page

2. **Verify Component Management State**
   - **Operators** → **Installed Operators** → **Red Hat OpenShift AI**
   - **Data Science Cluster** tab → check component `managementState: Managed`

3. **Check Pod Status**
   - **Workloads** → **Pods**
   - Filter by **Project**: `redhat-ods-applications`
   - Verify component pods are running

### Operator Installation Issues
1. **Check Operator Status**
   - **Operators** → **Installed Operators**
   - Look for operators in "Failed" or "Pending" state
   - Click operator to view detailed status and events

2. **Review Subscription Issues**
   - **Operators** → **Operator Management** → **Subscriptions**
   - Check for subscription conflicts or channel issues

### Service Mesh/KServe Setup Problems
1. **Verify Serverless Installation**
   - **Operators** → **Installed Operators** → **Red Hat OpenShift Serverless**
   - **Knative Serving** tab → check status is "Ready"

2. **Check Service Mesh Control Plane**
   - **Operators** → **Installed Operators** → **Red Hat OpenShift Service Mesh**
   - **Istio Service Mesh Control Plane** tab → verify "Ready" status
   - If failed, check **Events** tab for error details

### Performance Recommendations

When enabling multiple areas via UI:
- **Monitor Resource Usage**: **Observe** → **Dashboards** → check cluster resource consumption
- **Stagger Component Enablement**: Enable components one at a time to identify resource bottlenecks
- **Review Pod Limits**: **Workloads** → **Pods** → check resource requests/limits for optimization

This UI-focused approach allows developers to set up and test OpenShift AI features without requiring extensive CLI knowledge, making the development environment more accessible to a broader range of contributors.

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
