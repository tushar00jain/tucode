import assert from 'node:assert/strict';
import test from 'node:test';
import { Severity, NotificationPriority } from '../../src/vs/platform/notification/common/notification.js';
import { NotificationsModel } from '../../src/vs/workbench/common/notifications.js';
import { NotificationToastController } from '../../src/workbench/notificationToasts.js';

import { contextKeys } from './contextKeys.js';

test('notification toasts project real model items, hide without closing, and close through the model', () => {
	const model = new NotificationsModel();
	const contexts = contextKeys();
	const toasts = new NotificationToastController(model, contexts.service as any);
	const snapshots: string[][] = [];
	toasts.onDidSnapshot(snapshot => snapshots.push(snapshot.items.map(item => item.message)));

	model.addNotification({ severity: Severity.Warning, message: 'Insufficient terminals for the join action' });
	model.addNotification({ severity: Severity.Info, message: 'silent', priority: NotificationPriority.SILENT });
	assert.deepEqual(toasts.snapshot.items.map(item => item.message), ['Insufficient terminals for the join action']);
	assert.equal(model.notifications[1].visible, true);
	assert.equal(model.notifications[0].visible, false);
	assert.equal(contexts.values.get('notificationToastsVisible'), true);

	toasts.hide();
	assert.deepEqual([...toasts.snapshot.items], []);
	assert.equal(model.notifications.length, 2, 'Escape hiding a toast closed notification-center history');
	assert.equal(model.notifications[1].visible, false);
	assert.equal(contexts.values.get('notificationToastsVisible'), false);

	model.addNotification({ severity: Severity.Error, message: 'close me' });
	const id = toasts.snapshot.items[0].id;
	assert.equal(toasts.close(id), true);
	assert.equal(model.notifications.some(item => item.message.raw === 'close me'), false);
	assert.deepEqual(snapshots.at(-1), []);

	toasts.dispose();
	model.dispose();
});
