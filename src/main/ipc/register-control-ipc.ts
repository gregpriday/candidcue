import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { CHANNELS } from '@shared/contracts';
import {
  saveProjectInputSchema,
  sessionCommandSchema,
  prepareSessionInputSchema,
  providerCredentialInputSchema,
  providerNameSchema,
  exportFormatSchema,
} from '@shared/schemas';
import type { AppController } from '../app-controller';
import type { makeSenderGuard } from './sender-guards';

type Guard = ReturnType<typeof makeSenderGuard>;

const idSchema = z.string().min(1).max(200);

/** Register every ControlWindow channel with Zod validation + sender guards. */
export function registerControlIpc(app: AppController, guard: Guard): void {
  const control = (event: IpcMainInvokeEvent): void => guard(event.sender, ['control']);

  ipcMain.handle(CHANNELS.projectsList, (e) => {
    control(e);
    return app.listProjects();
  });
  ipcMain.handle(CHANNELS.projectsGet, (e, raw) => {
    control(e);
    return app.getProject(idSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.projectsSave, (e, raw) => {
    control(e);
    return app.saveProject(saveProjectInputSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.projectsRemove, (e, raw) => {
    control(e);
    return app.deleteProject(idSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.projectsPrepare, (e, raw) => {
    control(e);
    return app.prepareProject(idSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.projectsExport, (e, raw) => {
    control(e);
    return app.exportProject(idSchema.parse(raw), 'json');
  });
  ipcMain.handle(CHANNELS.projectsImportDocument, (e) => {
    control(e);
    return app.importDocument();
  });
  ipcMain.handle(CHANNELS.projectsImportMarkdownDocuments, (e) => {
    control(e);
    return app.importMarkdownDocuments();
  });

  ipcMain.handle(CHANNELS.settingsGetPublic, (e) => {
    control(e);
    return app.getPublicSettings();
  });
  ipcMain.handle(CHANNELS.settingsSaveProviders, (e, raw) => {
    control(e);
    return app.saveProviders(providerCredentialInputSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.settingsTestProvider, (e, raw) => {
    control(e);
    return app.testProvider(providerNameSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.settingsClearProvider, (e, raw) => {
    control(e);
    return app.clearProvider(providerNameSchema.parse(raw));
  });

  ipcMain.handle(CHANNELS.charactersList, (e) => {
    control(e);
    return app.listCharacters();
  });

  ipcMain.handle(CHANNELS.devicesListDisplays, (e) => {
    control(e);
    // display-manager runs in main; AppController exposes the rest.
    return import('../windows/display-manager').then((m) => m.listDisplays());
  });
  ipcMain.handle(CHANNELS.devicesSetDisplay, (e, raw) => {
    control(e);
    return app.setSelectedDisplay(idSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.devicesIdentifyDisplays, (e) => {
    control(e);
    return import('../windows/display-manager').then((m) => m.identifyDisplays());
  });

  ipcMain.handle(CHANNELS.sessionsPrepare, (e, raw) => {
    control(e);
    return app.prepareSession(prepareSessionInputSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.sessionsCommand, (e, raw) => {
    control(e);
    return app.command(sessionCommandSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.sessionsSnapshot, (e) => {
    control(e);
    return app.getSnapshot();
  });
  ipcMain.handle(CHANNELS.sessionsReview, (e, raw) => {
    control(e);
    return app.review(idSchema.parse(raw));
  });
  ipcMain.handle(CHANNELS.sessionsEditTranscript, (e, rawId, rawText) => {
    control(e);
    return app.editTranscript(idSchema.parse(rawId), z.string().max(50_000).parse(rawText));
  });
  ipcMain.handle(CHANNELS.sessionsExport, (e, rawId, rawFormat) => {
    control(e);
    return app.exportSession(idSchema.parse(rawId), exportFormatSchema.parse(rawFormat));
  });
  ipcMain.handle(CHANNELS.sessionsResumable, (e) => {
    control(e);
    return app.resumable();
  });
}
