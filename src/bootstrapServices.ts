import { Disposable } from './vs/base/common/lifecycle.js';
import { URI } from './vs/base/common/uri.js';
import { Schemas } from './vs/base/common/network.js';
import { ServiceCollection } from './vs/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from './vs/platform/instantiation/common/descriptors.js';
import { IExtensionsScannerService } from './vs/platform/extensionManagement/common/extensionsScannerService.js';
import { TauriExtensionsScannerService } from './vs/platform/extensionManagement/tauri/extensionsScannerService.js';
import { IFileService } from './vs/platform/files/common/files.js';
import { FileService } from './vs/platform/files/common/fileService.js';
import { FileUserDataProvider } from './vs/platform/userData/common/fileUserDataProvider.js';
import { ConsoleLogger, getLogLevel, ILoggerService, ILogService } from './vs/platform/log/common/log.js';
import { LogService } from './vs/platform/log/common/logService.js';
import { BufferLogger } from './vs/platform/log/common/bufferLog.js';
import { FileLoggerService } from './vs/platform/log/common/fileLog.js';
import { windowLogGroup, windowLogId } from './vs/workbench/services/log/common/logConstants.js';
import product from './vs/platform/product/common/product.js';
import { IProductService } from './vs/platform/product/common/productService.js';
import { IBrowserWorkbenchEnvironmentService } from './vs/workbench/services/environment/browser/environmentService.js';
import { IUriIdentityService } from './vs/platform/uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService, UserDataProfilesService } from './vs/platform/userDataProfile/common/userDataProfile.js';
import { IUserDataInitializationService, UserDataInitializationService } from './vs/workbench/services/userData/browser/userDataInit.js';
import { IUserDataProfileService } from './vs/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from './vs/workbench/services/userDataProfile/common/userDataProfileService.js';
import { IPolicyService, NullPolicyService } from './vs/platform/policy/common/policy.js';
import { ISignService } from './vs/platform/sign/common/sign.js';
import { SignService } from './vs/platform/sign/browser/signService.js';
import { IRemoteAuthorityResolverService } from './vs/platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from './vs/platform/remote/browser/remoteAuthorityResolverService.js';
import { IRemoteSocketFactoryService } from './vs/platform/remote/common/remoteSocketFactoryService.js';
import { IRemoteAgentService } from './vs/workbench/services/remote/common/remoteAgentService.js';
import { RemoteAgentService } from './vs/workbench/services/remote/browser/remoteAgentService.js';
import { IAnyWorkspaceIdentifier } from './vs/platform/workspace/common/workspace.js';
import { WorkspaceService } from './vs/workbench/services/configuration/browser/configurationService.js';
import { ConfigurationCache } from './vs/workbench/services/configuration/common/configurationCache.js';
import { IStorageService } from './vs/platform/storage/common/storage.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from './vs/platform/workspace/common/workspaceTrust.js';
import { WorkspaceTrustEnablementService, WorkspaceTrustManagementService } from './vs/workbench/services/workspaces/common/workspaceTrust.js';

/** Product metadata and extension scanning are identical for both frontend service graphs. */
export function registerBootstrapProduct(services: ServiceCollection, appResourceLocation: URI): IProductService {
	services.set(IExtensionsScannerService, new SyncDescriptor(TauriExtensionsScannerService, [appResourceLocation]));
	const productService: IProductService = { _serviceBrand: undefined, ...product };
	services.set(IProductService, productService);
	return productService;
}

/** Shared service construction; frontends supply their environment, profiles, sockets and storage. */
export class BootstrapServices extends Disposable {
	readonly fileService: FileService;
	readonly loggerService: FileLoggerService;
	readonly logService: LogService;

	constructor(
		private readonly serviceCollection: ServiceCollection,
		private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		private readonly productService: IProductService,
		consoleLogging = false
	) {
		super();
		const fileLogger = new BufferLogger();
		const fileService = this.fileService = this._register(new FileService(fileLogger));
		serviceCollection.set(IFileService, fileService);
		const loggerService = this.loggerService = this._register(new FileLoggerService(getLogLevel(environmentService), environmentService.logsHome, fileService));
		serviceCollection.set(ILoggerService, loggerService);
		const logger = loggerService.createLogger(environmentService.logFile, { id: windowLogId, name: windowLogGroup.name, group: windowLogGroup });
		// Terminal stdout/stderr belong to its renderer; only the Mac frontend logs to the console.
		const logService = this.logService = this._register(new LogService(logger,
			consoleLogging ? [new ConsoleLogger(loggerService.getLogLevel())] : []));
		serviceCollection.set(ILogService, logService);
		// FileService starts with a buffer to break its dependency cycle with the log service.
		fileLogger.logger = logService;
	}

	async initializeWorkspace(
		workspace: IAnyWorkspaceIdentifier,
		diskFileSystemProvider: ConstructorParameters<typeof FileUserDataProvider>[1],
		userDataProfilesService: UserDataProfilesService,
		uriIdentityService: IUriIdentityService,
		remoteSocketFactoryService: IRemoteSocketFactoryService
	) {
		const { serviceCollection, environmentService, productService, fileService, logService } = this;
		serviceCollection.set(IUserDataProfilesService, userDataProfilesService);

		// Use FileUserDataProvider for user data to
		// enable atomic read / write operations.
		this._register(fileService.registerProvider(Schemas.vscodeUserData, this._register(new FileUserDataProvider(Schemas.file, diskFileSystemProvider, Schemas.vscodeUserData, userDataProfilesService, uriIdentityService, logService))));

		const currentProfile = userDataProfilesService.getProfileForWorkspace(workspace) ?? userDataProfilesService.defaultProfile;
		await userDataProfilesService.setProfileForWorkspace(workspace, currentProfile);
		const userDataProfileService = new UserDataProfileService(currentProfile);
		serviceCollection.set(IUserDataProfileService, userDataProfileService);

		// No settings sync and no profile to seed from, so there is nothing to initialize —
		// the empty initializer list upstream also builds when neither is configured.
		serviceCollection.set(IUserDataInitializationService, new UserDataInitializationService());

		// Policies are a management feature we do not ship
		const policyService = new NullPolicyService();
		serviceCollection.set(IPolicyService, policyService);

		// Remote. No authority is ever resolved, but `WorkspaceService`, workspace trust and
		// `BaseTerminalProfileResolverService` take these as constructor arguments, so the
		// upstream stack is assembled and stays inert.
		const remoteAuthorityResolverService = new RemoteAuthorityResolverService(false, undefined, undefined, undefined, productService, logService);
		serviceCollection.set(IRemoteAuthorityResolverService, remoteAuthorityResolverService);
		const signService = new SignService(productService);
		serviceCollection.set(ISignService, signService);
		serviceCollection.set(IRemoteSocketFactoryService, remoteSocketFactoryService);
		const remoteAgentService = this._register(new RemoteAgentService(remoteSocketFactoryService, userDataProfileService, environmentService, productService, remoteAuthorityResolverService, signService, logService));
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		// Configuration and Storage
		const configurationCache = new ConfigurationCache([Schemas.file, Schemas.vscodeUserData, Schemas.tmp], environmentService, fileService);
		const configurationService = new WorkspaceService({ configurationCache }, environmentService, userDataProfileService, userDataProfilesService, fileService, remoteAgentService, uriIdentityService, logService, policyService);
		return { userDataProfileService, remoteAgentService, remoteAuthorityResolverService, configurationService };
	}

	registerWorkspaceTrust(configurationService: WorkspaceService, storageService: IStorageService,
		uriIdentityService: IUriIdentityService, remoteAuthorityResolverService: IRemoteAuthorityResolverService): void {
		const { serviceCollection, environmentService, fileService } = this;
		// Workspace Trust
		const workspaceTrustEnablementService = new WorkspaceTrustEnablementService(configurationService, environmentService);
		serviceCollection.set(IWorkspaceTrustEnablementService, workspaceTrustEnablementService);

		const workspaceTrustManagementService = new WorkspaceTrustManagementService(configurationService, remoteAuthorityResolverService, storageService, uriIdentityService, environmentService, configurationService, workspaceTrustEnablementService, fileService);
		serviceCollection.set(IWorkspaceTrustManagementService, workspaceTrustManagementService);

		configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted());
		this._register(workspaceTrustManagementService.onDidChangeTrust(() => configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted())));
	}
}
