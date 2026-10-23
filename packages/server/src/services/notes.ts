// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Note, NoteAnnotation, NoteCategory } from '@harness-nexus/core';
import {
  AppError,
  type CreateAnnotationInput,
  type CreateCategoryInput,
  type CreateNoteInput,
  type ListNotesQuery,
  type ListSquareQuery,
  type UpdateAnnotationInput,
  type UpdateCategoryInput,
  type UpdateNoteInput,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Notes domain service (#88) — the single authorization point for the notes
 * feature. Conventions per #53: Fastify-free, per-call deps, explicit
 * principal, AppError-only failures.
 *
 * Authorization (#36-shaped): notes are OWNER-ONLY for read and write;
 * `visibility: 'public'` widens read of the note ROW itself (the square and
 * the public detail view) and nothing else — annotations, categories and the
 * board stay owner-only. Foreign rows 404 (existence-hiding), never 403.
 */

function notFound(): AppError {
  return new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
}

async function ownNote(deps: ServiceDeps, caller: Principal, id: string): Promise<Note> {
  const note = await deps.uow.notes.findById(id);
  if (!note || note.ownerId !== caller.userId) throw notFound();
  return note;
}

/** A category id must belong to the caller; `null` (uncategorized) always passes. */
async function usableCategoryId(
  deps: ServiceDeps,
  caller: Principal,
  categoryId: string | null | undefined,
): Promise<void> {
  if (categoryId === undefined || categoryId === null) return;
  const category = await deps.uow.noteCategories.findById(categoryId);
  if (!category || category.ownerId !== caller.userId) {
    throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  }
}

function stampVersion(deps: ServiceDeps, note: Note, previousContent: string): Note {
  if (note.contentMd === previousContent) return note;
  const next: Note = { ...note, contentVersion: note.contentVersion + 1 };
  deps.uow.notes.saveVersion({
    noteId: next.id,
    version: next.contentVersion,
    contentMd: next.contentMd,
    createdAt: next.updatedAt,
  });
  return next;
}

// ---- notes ----

export async function listNotes(
  deps: ServiceDeps,
  caller: Principal,
  query: ListNotesQuery,
): Promise<Note[]> {
  const categoryId =
    query.categoryId !== undefined
      ? query.categoryId
      : query.category === 'uncategorized'
        ? null
        : undefined;
  return deps.uow.notes.list({
    ownerId: caller.userId,
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.visibility !== undefined ? { visibility: query.visibility } : {}),
    ...(query.tag !== undefined ? { tag: query.tag } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
    limit: query.limit,
    offset: query.offset,
  });
}

export async function listSquare(
  deps: ServiceDeps,
  _caller: Principal,
  query: ListSquareQuery,
): Promise<Note[]> {
  return deps.uow.notes.listPublic({
    ...(query.tag !== undefined ? { tag: query.tag } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
    limit: query.limit,
    offset: query.offset,
  });
}

export async function getNote(deps: ServiceDeps, caller: Principal, id: string): Promise<Note> {
  const note = await deps.uow.notes.findById(id);
  // Owner always; anyone for a public row (the square's detail view).
  if (!note || (note.ownerId !== caller.userId && note.visibility !== 'public')) {
    throw notFound();
  }
  return note;
}

export async function createNote(
  deps: ServiceDeps,
  caller: Principal,
  input: CreateNoteInput,
): Promise<Note> {
  await usableCategoryId(deps, caller, input.categoryId ?? null);
  const now = new Date().toISOString();
  const note: Note = {
    id: generateId(),
    ownerId: caller.userId,
    title: input.title,
    summary: input.summary ?? null,
    contentMd: input.contentMd,
    contentVersion: 1,
    categoryId: input.categoryId ?? null,
    tags: [...input.tags],
    status: input.status,
    visibility: input.visibility,
    source: {
      kind: input.source.kind,
      ...(input.source.ref !== undefined ? { ref: input.source.ref } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
  const saved = await deps.uow.notes.save(note);
  await deps.uow.notes.saveVersion({
    noteId: saved.id,
    version: 1,
    contentMd: saved.contentMd,
    createdAt: now,
  });
  return saved;
}

export async function updateNote(
  deps: ServiceDeps,
  caller: Principal,
  id: string,
  input: UpdateNoteInput,
): Promise<Note> {
  const note = await ownNote(deps, caller, id);
  await usableCategoryId(deps, caller, input.categoryId);

  const now = new Date().toISOString();
  let next: Note = {
    ...note,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.contentMd !== undefined ? { contentMd: input.contentMd } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    updatedAt: now,
  };
  // The version boundary: a body change bumps contentVersion and files an
  // immutable snapshot — the anchor target annotations pin to.
  next = stampVersion(deps, next, note.contentMd);
  return deps.uow.notes.save(next);
}

export async function deleteNote(deps: ServiceDeps, caller: Principal, id: string): Promise<void> {
  await ownNote(deps, caller, id);
  await deps.uow.notes.delete(id);
}

export async function findNoteVersion(
  deps: ServiceDeps,
  caller: Principal,
  id: string,
  version: number,
): Promise<{ noteId: string; version: number; contentMd: string; createdAt: string }> {
  const note = await ownNote(deps, caller, id);
  const snap = await deps.uow.notes.findVersion(note.id, version);
  if (!snap) throw notFound();
  return snap;
}

// ---- annotations ----

export async function listAnnotations(
  deps: ServiceDeps,
  caller: Principal,
  noteId: string,
): Promise<NoteAnnotation[]> {
  const note = await ownNote(deps, caller, noteId);
  return deps.uow.noteAnnotations.listByNote(note.id);
}

export async function createAnnotation(
  deps: ServiceDeps,
  caller: Principal,
  noteId: string,
  input: CreateAnnotationInput,
): Promise<NoteAnnotation> {
  const note = await ownNote(deps, caller, noteId);
  const now = new Date().toISOString();
  const annotation: NoteAnnotation = {
    id: generateId(),
    noteId: note.id,
    noteVersion: note.contentVersion,
    quote: input.quote,
    contextPrefix: input.contextPrefix,
    contextSuffix: input.contextSuffix,
    comment: input.comment,
    state: 'open',
    authorId: caller.userId,
    createdAt: now,
    resolvedAt: null,
  };
  return deps.uow.noteAnnotations.save(annotation);
}

export async function updateAnnotation(
  deps: ServiceDeps,
  caller: Principal,
  noteId: string,
  annotationId: string,
  input: UpdateAnnotationInput,
): Promise<NoteAnnotation> {
  await ownNote(deps, caller, noteId);
  const annotation = await deps.uow.noteAnnotations.findById(annotationId);
  if (!annotation || annotation.noteId !== noteId) {
    throw new AppError('Annotation not found', 404, 'ANNOTATION_NOT_FOUND');
  }
  const next: NoteAnnotation = {
    ...annotation,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.state !== undefined
      ? { resolvedAt: input.state === 'done' ? (annotation.resolvedAt ?? new Date().toISOString()) : null }
      : {}),
  };
  return deps.uow.noteAnnotations.save(next);
}

export async function deleteAnnotation(
  deps: ServiceDeps,
  caller: Principal,
  noteId: string,
  annotationId: string,
): Promise<void> {
  await ownNote(deps, caller, noteId);
  const annotation = await deps.uow.noteAnnotations.findById(annotationId);
  if (!annotation || annotation.noteId !== noteId) {
    throw new AppError('Annotation not found', 404, 'ANNOTATION_NOT_FOUND');
  }
  await deps.uow.noteAnnotations.delete(annotationId);
}

// ---- categories ----

export async function listCategories(
  deps: ServiceDeps,
  caller: Principal,
): Promise<NoteCategory[]> {
  return deps.uow.noteCategories.listByOwner(caller.userId);
}

export async function createCategory(
  deps: ServiceDeps,
  caller: Principal,
  input: CreateCategoryInput,
): Promise<NoteCategory> {
  if (input.parentId !== null) {
    const parent = await deps.uow.noteCategories.findById(input.parentId);
    if (!parent || parent.ownerId !== caller.userId) {
      throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
    }
  }
  const taken = await deps.uow.noteCategories.findByParentAndName(
    caller.userId,
    input.parentId,
    input.name,
  );
  if (taken) {
    throw new AppError('A category with this name already exists here', 409, 'CATEGORY_NAME_TAKEN');
  }
  const category: NoteCategory = {
    id: generateId(),
    ownerId: caller.userId,
    parentId: input.parentId,
    name: input.name,
    createdAt: new Date().toISOString(),
  };
  return deps.uow.noteCategories.save(category);
}

export async function updateCategory(
  deps: ServiceDeps,
  caller: Principal,
  id: string,
  input: UpdateCategoryInput,
): Promise<NoteCategory> {
  const category = await deps.uow.noteCategories.findById(id);
  if (!category || category.ownerId !== caller.userId) {
    throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  }
  let parentId = category.parentId;
  if (input.parentId !== undefined) {
    if (input.parentId !== null) {
      const parent = await deps.uow.noteCategories.findById(input.parentId);
      if (!parent || parent.ownerId !== caller.userId) {
        throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
      }
      // A node cannot move under itself or any of its descendants.
      let cursor: NoteCategory | null = parent;
      while (cursor !== null) {
        if (cursor.id === id) {
          throw new AppError(
            'A category cannot be moved under itself',
            400,
            'CATEGORY_CYCLE',
          );
        }
        cursor =
          cursor.parentId === null
            ? null
            : await deps.uow.noteCategories.findById(cursor.parentId);
      }
      parentId = input.parentId;
    } else {
      parentId = null;
    }
  }
  const name = input.name ?? category.name;
  if (name !== category.name || parentId !== category.parentId) {
    const taken = await deps.uow.noteCategories.findByParentAndName(
      caller.userId,
      parentId,
      name,
    );
    if (taken && taken.id !== id) {
      throw new AppError(
        'A category with this name already exists here',
        409,
        'CATEGORY_NAME_TAKEN',
      );
    }
  }
  return deps.uow.noteCategories.save({ ...category, parentId, name });
}

export async function deleteCategory(
  deps: ServiceDeps,
  caller: Principal,
  id: string,
): Promise<void> {
  const category = await deps.uow.noteCategories.findById(id);
  if (!category || category.ownerId !== caller.userId) {
    throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  }
  await deps.uow.noteCategories.delete(id);
}
