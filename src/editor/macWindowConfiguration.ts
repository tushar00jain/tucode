import { Registry } from '../vs/platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../vs/platform/configuration/common/configurationRegistry.js';
import { windowConfigurationNodeBase } from '../vs/workbench/common/configuration.js';

// The desktop contribution that registers this application setting requires Electron.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	...windowConfigurationNodeBase,
	properties: {
		'window.nativeTabs': {
			type: 'boolean', default: false, scope: ConfigurationScope.APPLICATION,
			description: 'Open folders in macOS native window tabs. Applies to subsequently opened folders.'
		}
	}
});
