// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  AppError,
  createAnnotationSchema,
  createCategorySchema,
  createNoteSchema,
  listNotesQuerySchema,
  listSquareQuerySchema,
  summarizeNoteSchema,
  updateAnnotationSchema,
  updateCategorySchema,
  updateNoteSchema,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import {
  createAnnotation,
  createCategory,
  createNote,
  deleteAnnotation,
  deleteCategory,
  deleteNote,
  findNoteVersion,
  getNote,
  listAnnotations,
  listCategories,
  listNotes,
  listSquare,
  updateAnnotation,
  updateCategory,
  updateNote,
} from '../services/notes.js';
import { reviseNoteByAnnotations, summarizeNoteContent } from '../services/notes-ai.js';

/**
 * Notes routes (#88) — thin HTTP adapters over the notes service. Every
 * owner/visibility gate lives in the service (#53); this file authenticates,
 * parses the shared zod shapes, and frames the reply.
 */
export async function notesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = () => ({ uow: app.uow });

  // ---- GET /api/notes — own feed (filters + pagination) ----
  app.get('/api/notes', guard, async (req) => {
    const query = listNotesQuerySchema.parse(req.query);
    const notes = await listNotes(deps(), principalOf(req), query);
    return { notes };
  });

  // ---- GET /api/notes/square — every user's public notes ----
  app.get('/api/notes/square', guard, async (req) => {
    const query = listSquareQuerySchema.parse(req.query);
    const notes = await listSquare(deps(), principalOf(req), query);
    return { notes };
  });

  // ---- POST /api/notes/summarize — one-shot LLM summary (#88 AI pass) ----
  app.post('/api/notes/summarize', guard, async (req) => {
    const input = summarizeNoteSchema.parse(req.body);
    const result = await summarizeNoteContent(
      { uow: app.uow, credentialEncryptionKey: app.credentialEncryptionKey },
      principalOf(req),
      input,
    );
    return result;
  });

  // ---- POST /api/notes/:id/revise — apply open annotations, mint next version ----
  app.post<{ Params: { id: string } }>('/api/notes/:id/revise', guard, async (req) => {
    const result = await reviseNoteByAnnotations(
      { uow: app.uow, credentialEncryptionKey: app.credentialEncryptionKey },
      principalOf(req),
      req.params.id,
    );
    return result;
  });

  // ---- POST /api/notes ----
  app.post('/api/notes', guard, async (req, reply) => {
    const input = createNoteSchema.parse(req.body);
    const note = await createNote(deps(), principalOf(req), input);
    return reply.code(201).send({ note });
  });

  // ---- GET /api/notes/:id — owner always; public rows for everyone ----
  app.get<{ Params: { id: string } }>('/api/notes/:id', guard, async (req) => {
    const note = await getNote(deps(), principalOf(req), req.params.id);
    return { note };
  });

  // ---- GET /api/notes/:id/versions/:version — the annotation anchor target ----
  app.get<{ Params: { id: string; version: string } }>(
    '/api/notes/:id/versions/:version',
    guard,
    async (req) => {
      const version = Number.parseInt(req.params.version, 10);
      if (!Number.isInteger(version) || version < 1) {
        throw new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
      }
      const snapshot = await findNoteVersion(deps(), principalOf(req), req.params.id, version);
      return { version: snapshot };
    },
  );

  // ---- PATCH /api/notes/:id ----
  app.patch<{ Params: { id: string } }>('/api/notes/:id', guard, async (req) => {
    const input = updateNoteSchema.parse(req.body);
    const note = await updateNote(deps(), principalOf(req), req.params.id, input);
    return { note };
  });

  // ---- DELETE /api/notes/:id ----
  app.delete<{ Params: { id: string } }>('/api/notes/:id', guard, async (req) => {
    await deleteNote(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });

  // ---- annotations (owner-only working material) ----
  app.get<{ Params: { id: string } }>('/api/notes/:id/annotations', guard, async (req) => {
    const annotations = await listAnnotations(deps(), principalOf(req), req.params.id);
    return { annotations };
  });

  app.post<{ Params: { id: string } }>('/api/notes/:id/annotations', guard, async (req, reply) => {
    const input = createAnnotationSchema.parse(req.body);
    const annotation = await createAnnotation(deps(), principalOf(req), req.params.id, input);
    return reply.code(201).send({ annotation });
  });

  app.patch<{ Params: { id: string; annotationId: string } }>(
    '/api/notes/:id/annotations/:annotationId',
    guard,
    async (req) => {
      const input = updateAnnotationSchema.parse(req.body);
      const annotation = await updateAnnotation(
        deps(),
        principalOf(req),
        req.params.id,
        req.params.annotationId,
        input,
      );
      return { annotation };
    },
  );

  app.delete<{ Params: { id: string; annotationId: string } }>(
    '/api/notes/:id/annotations/:annotationId',
    guard,
    async (req) => {
      await deleteAnnotation(deps(), principalOf(req), req.params.id, req.params.annotationId);
      return { ok: true };
    },
  );

  // ---- categories ----
  app.get('/api/notes/categories', guard, async (req) => {
    const categories = await listCategories(deps(), principalOf(req));
    return { categories };
  });

  app.post('/api/notes/categories', guard, async (req, reply) => {
    const input = createCategorySchema.parse(req.body);
    const category = await createCategory(deps(), principalOf(req), input);
    return reply.code(201).send({ category });
  });

  app.patch<{ Params: { id: string } }>('/api/notes/categories/:id', guard, async (req) => {
    const input = updateCategorySchema.parse(req.body);
    const category = await updateCategory(deps(), principalOf(req), req.params.id, input);
    return { category };
  });

  app.delete<{ Params: { id: string } }>('/api/notes/categories/:id', guard, async (req) => {
    await deleteCategory(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });
}
