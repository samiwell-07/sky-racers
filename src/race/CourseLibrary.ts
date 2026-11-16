import type { CourseDef } from './Course';
import { BUILTIN_COURSES } from './Course';
import { browserStorage, tryGetItem, tryParseJson, trySetItem, type KeyValueStorage, type SaveResult } from '../settings/safeStorage';

const KEY = 'sfr.customCourses';

/** Built-in courses, plus any custom courses saved in localStorage. */
export class CourseLibrary {
  constructor(private readonly storage: KeyValueStorage | null = browserStorage()) {}

  /** Valid custom courses (invalid entries are skipped, not erased). */
  custom(): CourseDef[] {
    const raw = tryGetItem(this.storage, KEY);
    const list = raw ? tryParseJson(raw, 'custom courses') : [];
    if (!Array.isArray(list)) return [];
    const valid = list.filter(isValidCourse);
    if (valid.length < list.length) console.warn(`Ignoring ${list.length - valid.length} invalid custom course(s).`);
    return valid;
  }

  all(): CourseDef[] {
    return [...BUILTIN_COURSES, ...this.custom()];
  }

  get(id: string): CourseDef | undefined {
    return this.all().find((c) => c.id === id);
  }

  save(course: CourseDef): SaveResult {
    const list = this.custom().filter((c) => c.id !== course.id);
    list.push(course);
    return trySetItem(this.storage, KEY, JSON.stringify(list));
  }

  remove(id: string): SaveResult {
    return trySetItem(this.storage, KEY, JSON.stringify(this.custom().filter((c) => c.id !== id)));
  }
}

export function isValidCourse(c: unknown): c is CourseDef {
  const v = c as CourseDef;
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    Array.isArray(v.gates) &&
    v.gates.length >= 2 &&
    v.gates.every((g) => !!g && Number.isFinite(g.x) && Number.isFinite(g.z)) &&
    (v.version === undefined || Number.isInteger(v.version))
  );
}
