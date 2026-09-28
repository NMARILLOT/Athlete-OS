import { relations } from "drizzle-orm";
import { activities, activityLaps, activityStreams, rawPayloads } from "./activities";
import { exerciseAliases, exercises } from "./exercises";
import { athleteProfiles, trainingBlocks, userPreferences, users } from "./users";
import {
  cardioWorkouts,
  coachSessions,
  crossfitWorkouts,
  strengthSets,
  workoutAnalyses,
  workoutExercises,
  workouts,
} from "./workouts";

/**
 * Drizzle schema — DATA_MODEL.md v2. One module per aggregate; this index re-exports every
 * table (drizzle-kit reads it) and declares the relations the query API uses.
 */
export * from "./enums";
export * from "./users";
export * from "./exercises";
export * from "./workouts";
export * from "./inbox";
export * from "./activities";
export * from "./recovery";
export * from "./records";
export * from "./engine";
export * from "./calendar";
export * from "./integrations";

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(athleteProfiles, {
    fields: [users.id],
    references: [athleteProfiles.userId],
  }),
  preferences: one(userPreferences, {
    fields: [users.id],
    references: [userPreferences.userId],
  }),
  workouts: many(workouts),
  trainingBlocks: many(trainingBlocks),
}));

export const exercisesRelations = relations(exercises, ({ many }) => ({
  aliases: many(exerciseAliases),
}));

export const exerciseAliasesRelations = relations(exerciseAliases, ({ one }) => ({
  exercise: one(exercises, {
    fields: [exerciseAliases.exerciseId],
    references: [exercises.id],
  }),
}));

export const workoutsRelations = relations(workouts, ({ one, many }) => ({
  user: one(users, { fields: [workouts.userId], references: [users.id] }),
  exercises: many(workoutExercises),
  sets: many(strengthSets),
  analyses: many(workoutAnalyses),
  activities: many(activities),
  cardio: one(cardioWorkouts, {
    fields: [workouts.id],
    references: [cardioWorkouts.workoutId],
  }),
  crossfit: one(crossfitWorkouts, {
    fields: [workouts.id],
    references: [crossfitWorkouts.workoutId],
  }),
  coachSession: one(coachSessions, {
    fields: [workouts.id],
    references: [coachSessions.workoutId],
  }),
}));

export const workoutExercisesRelations = relations(workoutExercises, ({ one, many }) => ({
  workout: one(workouts, { fields: [workoutExercises.workoutId], references: [workouts.id] }),
  exercise: one(exercises, { fields: [workoutExercises.exerciseId], references: [exercises.id] }),
  sets: many(strengthSets),
}));

export const strengthSetsRelations = relations(strengthSets, ({ one }) => ({
  workout: one(workouts, { fields: [strengthSets.workoutId], references: [workouts.id] }),
  workoutExercise: one(workoutExercises, {
    fields: [strengthSets.workoutExerciseId],
    references: [workoutExercises.id],
  }),
  exercise: one(exercises, { fields: [strengthSets.exerciseId], references: [exercises.id] }),
}));

export const workoutAnalysesRelations = relations(workoutAnalyses, ({ one }) => ({
  workout: one(workouts, { fields: [workoutAnalyses.workoutId], references: [workouts.id] }),
}));

export const activitiesRelations = relations(activities, ({ one, many }) => ({
  workout: one(workouts, { fields: [activities.workoutId], references: [workouts.id] }),
  rawPayload: one(rawPayloads, {
    fields: [activities.rawPayloadId],
    references: [rawPayloads.id],
  }),
  laps: many(activityLaps),
  streams: many(activityStreams),
}));

export const activityLapsRelations = relations(activityLaps, ({ one }) => ({
  activity: one(activities, { fields: [activityLaps.activityId], references: [activities.id] }),
}));

export const activityStreamsRelations = relations(activityStreams, ({ one }) => ({
  activity: one(activities, {
    fields: [activityStreams.activityId],
    references: [activities.id],
  }),
}));
