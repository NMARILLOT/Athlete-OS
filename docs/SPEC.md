# ATHLETE OS — CAHIER DES CHARGES (source de vérité produit)

> Ce document est le cahier des charges initial fourni par Nicolas. Il est la référence produit.
> Les documents `ARCHITECTURE.md`, `DATA_MODEL.md`, `ENGINE.md` et `DECISIONS.md` en dérivent.

Application personnelle appelée provisoirement **Athlete OS** : un vrai produit utilisable au quotidien, pas une démo.
Application de long terme, évolutive, mobile-first, installable comme PWA sur iPhone, déployée sur Vercel.

---

## 1. Situation

Beaucoup de liberté dans l'emploi du temps ; objectif : devenir un athlète hybride très complet.

Objectifs, dans l'ordre :
1. Santé et longévité.
2. Devenir très performant en CrossFit.
3. Développer une grosse capacité cardiovasculaire et d'endurance.
4. Devenir fort et puissant.
5. Construire un physique athlétique et harmonieux.
6. S'amuser énormément à l'entraînement.

Ne PAS (pour l'instant) : compter les calories ; suivre une sèche ; une application obsédée par le poids ; transformer le sport en contrainte mentale.
Le poids et la composition corporelle peuvent être enregistrés automatiquement à titre informatif et pour certaines métriques relatives, jamais comme objectif principal.

Coach de CrossFit ~1 à 2 séances/mois : ces séances doivent être enregistrables dans l'agenda avec leur éventuelle charge physique.
Matériel : Garmin + ceinture Garmin HRM-Pro Plus. Balance à impédancemétrie (marque à renseigner ultérieurement).

## 2. Philosophie centrale

Réduire au maximum la charge mentale. L'application transforme toutes les données disponibles en une réponse extrêmement simple :
**Voici ce que tu fais aujourd'hui.** Tout en laissant le choix entre quelques alternatives compatibles.

Principe UX : **Minimum d'actions → maximum d'intelligence.** Une donnée n'est demandée manuellement que si elle ne peut pas être calculée ou récupérée automatiquement.

## 3. Programmation adaptative

Pas de calendrier figé sur 12 semaines. Un **moteur de programmation adaptatif et glissant**. Chaque semaine possède des objectifs/stimuli à atteindre :
force bas du corps ; force haut du corps ; hypertrophie ; technique haltérophilie ; gymnastique ; endurance fondamentale ; sortie aérobie longue ; seuil ; VO2max ; puissance ; CrossFit/conditioning ; mobilité/récupération.
Les séances CrossFit sont variables : la programmation de la box est une **entrée dynamique**.

## 4. Le problème CrossFit à résoudre

Quand je fais une séance CrossFit, je renseigne ou importe le WOD (ex. Back squat 5×5 lourd + 12 min AMRAP 12 wall balls / 10 burpees / 250 m row).
L'application analyse automatiquement : squat dominant ; charge quadriceps/fessiers ; force jambes ; conditioning glycolytique ; rameur ; impacts modérés ; durée ; intensité probable ; muscles ; patterns moteurs ; systèmes énergétiques.
Puis elle modifie automatiquement le reste de la programmation : PAS de deuxième séance jambes lourde, pas d'intervalles vélo violents, pas de deuxième gros metcon, pas de squat lourd le lendemain. Elle peut proposer : rien ; Zone 2 facile ; mobilité ; accessoires haut du corps ; récupération active.

## 5. WOD Inbox

Ajout d'un WOD de quatre façons : 1) texte copié-collé ; 2) saisie rapide ; 3) capture d'écran/photo ; 4) connecteur/API ultérieure.
Une IA transforme le WOD en structure normalisée : mouvements ; séries ; répétitions ; charges ; durée ; modalité ; stimulus ; muscles ; pattern moteur ; difficulté technique ; impact articulaire ; intensité cardio estimée ; durée sous tension ; dominante force/hypertrophie/skill/conditioning ; time domain ; système énergétique principal.

Patterns moteurs minimum : squat ; hinge ; horizontal push ; vertical push ; horizontal pull ; vertical pull ; carry ; locomotion ; rotation/core ; Olympic lift ; gymnastics.
Modalités : running ; bike ; row ; ski ; swimming ; strength ; gymnastics ; weightlifting ; mixed modal.

L'analyse IA produit du **JSON validé par schema**. L'IA n'écrit jamais directement dans la programmation sans validation par le moteur de règles.

## 6. Moteur de planification — deux couches

**Couche A — règles déterministes** : fréquence des séances difficiles ; répétition des patterns ; récupération ; volume ; progression ; exposition musculaire ; charge hebdo ; répartition endurance/intensité ; jours faciles/difficiles ; tests ; deload ; historique blessures/douleurs.
**Couche B — IA** : interprète les WOD ; explique les décisions ; propose des alternatives fun ; aide à générer une séance quand plusieurs possibilités sont valides ; transforme une demande naturelle en workout structuré. Elle ne peut pas contourner les règles de sécurité de la couche A.

## 7. Budget hebdomadaire de stimuli — exposure ledger

Ne pas raisonner en nombre de séances. Chaque séance **crédite** des stimuli (ex. 5×3 deadlift lourd + 21-15-9 cal bike/deadlift → hinge strength élevé ; posterior chain élevé ; CrossFit conditioning élevé ; high intensity cardio élevé).
Le système regarde ce qui manque dans la semaine et **remplit les trous** plutôt que d'empiler. CrossFit + musculation + running forment un seul programme.

## 8. Structure générale visée

À terme 8 à 12 h/semaine si la récupération le permet, construit progressivement. Points de départ (pas des contraintes absolues) :
CrossFit 3–4 expositions/sem ; force/hypertrophie 2–3 ; endurance ~3 ; beaucoup d'aérobie facile ; 2–3 expositions réellement intenses max (WOD compris) ; au moins une vraie période de récupération hebdomadaire.

## 9. Écran Home — TODAY

Répond immédiatement : **Aujourd'hui** → Séance principale (`CROSSFIT — 18:30` / `RUN — Zone 2 — 60 min` / `STRENGTH — Upper`) → éventuel Bonus (`30 min Zone 2` / `10 min mobilité` / `Rien aujourd'hui. Récupère.`) → une phrase très courte expliquant pourquoi.
Boutons : START · AUTRE OPTION · JE VAIS AU CROSSFIT · JE VEUX JUSTE BOUGER · REPOS.

## 10. Mode musculation

UI dédiée, extrêmement simple : exercice courant ; démo éventuelle ; série actuelle ; reps demandées ; poids proposé ; poids de la dernière séance ; meilleur récent ; RIR/RPE cible ; timer de récup automatique.
Après une série : [VALIDER] puis éventuellement RPE facile/parfait/dur/échec (ou slider ultra rapide). Poids suivant proposé automatiquement. Boutons −2,5 / +2,5 / +5 kg. Aucune saisie complexe.

## 11. Progression musculation

Utiliser : historique de charge ; reps ; RIR/RPE ; e1RM ; qualité des séries ; fréquence d'exposition.
**e1RM** : Epley par défaut `e1RM = poids × (1 + reps/30)`, conserver la formule, ne pas la changer silencieusement, éviter pour séries très longues, afficher la tendance plutôt qu'une fausse précision.
**Progression** : toutes les séries en haut de plage avec assez de RIR → augmenter légèrement ; cible atteinte mais difficile → conserver ; plusieurs séries échouent → réduire/modifier. Le système apprend mes incréments disponibles (haltères +2 kg ; barre +2,5 kg ; machines selon plaques).

## 12. Mode cardio

Fortement intégré à Garmin. Séances : Zone 2 ; endurance longue ; recovery run ; tempo ; threshold ; VO2max ; intervalles ; fartlek ; hill repeats ; strides ; vélo ; rameur ; SkiErg ; natation ultérieurement.
`SEND TO GARMIN` → apparaît dans Garmin Connect/calendrier via l'API officielle ; la montre guide échauffement, durée, distance, allure, FC, répétitions, récupération, retour au calme.

## 13. Garmin

APIs officielles uniquement autant que possible. **Training API** (envoyer workouts, intervalles, plans) ; **Activity API** (activités, détails, FIT, laps, cardio, allure, puissance, cadence, running dynamics) ; **Health API** (sommeil, FC, RHR, stress, Body Battery, respiration, HRV, composition corporelle…).
OAuth 2.0. Ne jamais stocker les identifiants Garmin. Tokens sécurisés côté serveur, refresh + rotation. Webhooks/synchronisations **idempotents**. Copie normalisée + données brutes pour recalcul ultérieur.

## 14. Garmin API pas encore disponible

Le projet doit fonctionner avant validation du Garmin Developer Program. `GarminProvider` avec `GarminOfficialProvider` et `GarminMockProvider`. Pas de scraper avec login/mot de passe. Pendant le dev : mock réaliste ; import manuel FIT ; séance cardio affichée ; export si pertinent. Une fois les credentials obtenus : activation du provider officiel sans réécrire l'app.

## 15. HRM-Pro Plus

Exploiter quand disponible : FC ; cadence ; longueur de foulée ; oscillation verticale ; ratio vertical ; ground contact time ; ground contact balance ; running power si compatible. **Ne jamais inventer une métrique absente.**

## 16. Zones cardio

Pas de 220 − âge automatique. Priorité : 1) LTHR Garmin fiable ; 2) test spécifique ; 3) HR reserve ; 4) valeurs Garmin existantes. **Versions historiques des zones** : une séance de février conserve les zones de février.

## 17. Métriques endurance

Temps ; distance ; allure ; FC moy/max ; temps par zone ; puissance ; dénivelé ; cadence ; stride length ; GCT ; oscillation ; ratio vertical.
Tendances : **Pace @ HR** (allure à 145–150 bpm sur sorties comparables) ; **aerobic decoupling** (1re vs 2e moitié) ; **efficiency factor** ; **threshold trend** (allure/FC/puissance seuil).
Tests standardisés : 5 km ; 10 km ; Cooper ; 2 km row ; 5 km row ; BikeErg ; SkiErg ; autre. Ne pas tester toutes les semaines.

## 18. CrossFit metrics

Conserver : WOD ; score ; Rx/scaled ; durée ; reps ; rounds ; charges ; mouvements ; time domain ; FC ; RPE ; densité.
Benchmarks : Fran ; Grace ; Diane ; Helen ; Murph ; Open ; personnalisés.
PR : clean ; jerk ; C&J ; snatch ; front squat ; back squat ; deadlift ; bench ; strict press ; push press ; pull-ups ; C2B ; T2B ; muscle-ups ; handstand walk ; double-unders ; autres.

## 19. Pas de score magique

Pas de « Fitness Score = 83/100 » sans signification physiologique. Quatre tableaux transparents : **STRENGTH** (e1RM, PR) ; **ENGINE** (allure/FC/seuil/endurance/tests) ; **CROSSFIT** (benchmarks/skills/WOD) ; **RECOVERY** (sommeil/RHR/HRV/stress/subjectif). Tout score composite : formule visible, documentée, désactivable.

## 20. Charge d'entraînement unifiée

**session-RPE load** = durée (min) × RPE (60 × 7 = 420 AU) en complément des métriques spécifiques. Afficher charge quotidienne, hebdo, moyenne glissante, tendance 7 j et 28 j. Ne pas présenter un ratio de charge comme prédiction fiable de blessure.

## 21. Readiness

Chaque matin, récupérer automatiquement : sommeil ; RHR ; HRV ; stress ; Body Battery ; entraînement récent. Puis demander au maximum 3 choses : Énergie 😫😐😃 ; Courbatures 0–3 ; Envie 😫😐😃 ; éventuellement douleur inhabituelle OUI/NON (→ localisation, intensité).
Le readiness **ne décide pas seul** de supprimer une séance ; il influence le moteur.

## 22. Feedback après séance

« Comment c'était ? » 😍 Trop bien / 🙂 Bien / 😐 Moyen / 😵 Trop dur ; RPE 1–10 ; douleur inhabituelle oui/non. Saisie < 10 s. **Fun score** suivi pour détecter si le programme devient chiant.

## 23. Mode fun — SURPRISE ME

3 activités compatibles avec la programmation (ex. A 45 min trail facile ; B WOD partner 25 min ; C vélo extérieur 90 min) respectant les contraintes de récupération.

## 24. Coaching CrossFit — COACH_SESSION

Durée ; heure ; niveau de démonstration physique (aucune / légère / modérée / importante). Pas automatiquement un workout, mais temps debout, démonstrations, fatigue ressentie intégrés au contexte de récupération.

## 25. Composition corporelle

Module optionnel : poids ; body fat ; masse musculaire ; eau ; autres. Afficher clairement que les mesures individuelles sont bruitées ; tendances multi-semaines. Jamais « Tu dois perdre X kg ». Utilisé pour force/puissance relative.

## 26. Connecteurs balance — BodyCompositionProvider

Implémentations : Withings ; Garmin ; autre ; manual ; webhook. Toutes les mesures dans le même modèle normalisé.

## 27. Dashboard PROGRESS

Filtres 7 j / 4 sem / 3 mois / 6 mois / 1 an / ALL. Sections : Training volume (h/sem) ; Distribution (CrossFit / Strength / Easy endurance / Hard endurance / Recovery) ; Strength (e1RM) ; Aerobic engine (pace@HR, threshold pace, VO2max Garmin, tests) ; CrossFit (benchmarks, PR) ; Recovery (RHR, HRV, sommeil, Body Battery) ; Enjoyment (fun score).

## 28. Page EXERCISE

Par mouvement : current e1RM ; recent PR ; best PR ; last exposure ; weekly sets ; recent loads ; graphique ; historique des séries.

## 29. Page ACTIVITY

Activité Garmin : résumé ; laps ; graphique FC ; pace ; altitude.

## 30. Comparaison intelligente

Ne jamais comparer n'importe quelles séances. Prendre en compte type, durée, distance, terrain, dénivelé, FC, puissance, température, fatigue préalable. **Groupes de séances comparables** (`easy_run_flat_45_75min`, `zone2_bike_indoor`, `crossfit_short_mixed_modal`, `back_squat_strength`).

## 31. Principe absolu : s'entraîner intelligemment

S'entraîner beaucoup lorsque c'est pertinent, peu lorsque c'est pertinent, toujours de la manière la plus intelligente pour progresser à long terme. Meilleur compromis entre objectifs, performances, métriques, historique, récupération, contraintes, douleurs, programmation CrossFit, disponibilités et **envies du moment**. Adaptatif et personnel, jamais générique.

## 32. Mes envies font partie des données

« J'ai envie de courir aujourd'hui » ; « CrossFit demain » ; « beaucoup de vélo cette semaine » ; « grosse séance avec des copains samedi » ; « aucune envie de musculation ». Jamais « Impossible, ce n'est pas dans ton programme » : réorganiser intelligemment (ex. Strength Lower prévu → run si pas de contre-indication, puis repositionner la force).

## 33. L'app doit aussi savoir me freiner

Ex. lundi gros squat + WOD jambes ; mardi intervalles ; mercredi deadlift + CrossFit ; jeudi récup médiocre ; demande « gros Hyrox ce soir » → « Mauvaise idée aujourd'hui. Tes jambes ont déjà reçu trois gros stimuli en quatre jours. On garde l'esprit Hyrox : 45 min faciles + SkiErg technique. » Toujours une alternative, jamais un simple blocage.

## 34–35. Objectifs pondérés

Long terme (santé, longévité, CrossFit, endurance, force, physique, plaisir) ; moyen terme (5 km, clean, muscle-ups, Zone 2, Hyrox, Open, trail) ; court terme (3 expositions aérobies cette semaine, snatch ×2, éviter 3e jour jambes intense, placer une sortie longue).
Pondération interne configurable (santé/longévité très élevée ; CrossFit, endurance, force élevées ; physique moyenne ; 5 km variable). L'IA ne modifie jamais durablement les priorités sans accord.

## 36. Phases et blocs

Blocs possibles (aerobic base + force ; strength + threshold ; CrossFit performance ; Hyrox) sans rigidité. Une dominante ne fait jamais disparaître les autres capacités.

## 37. Micro-ajustement quotidien

`plannedTraining + recentTraining + crossfitProgramming + readiness + painStatus + weeklyStimulusLedger + currentGoals + userPreference + calendarAvailability = todayRecommendation` contenant : séance principale ; éventuel complément ; alternatives ; explication courte ; niveau de confiance.

## 38. Macro-ajustement hebdomadaire

Fin de semaine : objectifs atteints ; stimuli manquants/excessifs ; volume ; intensité ; PR ; fatigue ; douleurs ; sommeil ; plaisir ; envie. Préparer la semaine suivante. Pas de compensation stupide d'une séance manquée : repartir de la situation réelle.

## 39. Apprendre mon profil — AthleteModel

Volumes tolérés ; séances qui fatiguent ; mouvements coûteux ; temps de récup ; sports préférés ; séances sautées/adorées ; horaires performants ; combinaisons qui fonctionnent/détruisent ; progression par exercice. Ex. 100 wall balls → 48 h de fatigue quads → coût estimé augmenté. Couche `AthleteModel` distincte des règles générales.

## 40. Personal baselines

RHR 28 j ; HRV ; sommeil ; charge hebdo ; volume running ; RPE moyen par séance. « Est-ce inhabituel pour Nicolas ? »

## 41. Performance vs fatigue

`fitnessSignal` / `fatigueSignal` sans prétendre mesurer parfaitement. Distinguer adaptation positive probable (volume ↑ progressif, perf ↑, récup stable) et surcharge potentielle (perf ↓, RPE ↑, sommeil ↓, douleurs ↑, envie ↓) → proposer réduction.

## 42. Deload intelligent

Pas rigide 3 ON / 1 OFF. Déclenché par charge accumulée, stagnation, récupération, douleurs, événements, compétitions, fatigue subjective ; plus deloads préventifs périodiques. Volume / intensité / densité / complexité / impacts. Pas forcément ne rien faire.

## 43. Double séance

Support des doubles (matin Zone 2 60 min / soir CrossFit) seulement si cela apporte quelque chose. Gérer ordre, temps entre séances, interférence force/endurance, alimentation/récup, charge totale. Jamais une double juste parce que j'ai du temps.

## 44. Minimum Effective Dose / Optimal Adaptive Range / Excessive Load

Chercher progressivement la zone productive propre à mon profil, pas le volume maximal.

## 45. Cardio : polarisation intelligente

Protéger le volume facile. EASY (conversation) / MODERATE-TEMPO / HARD (threshold, VO2, intervals). Le CrossFit intense compte dans le budget d'intensité cardio.

## 46. Fatigue cardio vs musculaire

Suivre séparément : cardiovascular load ; muscular load ; impact load ; eccentric load ; technical load. Aide à choisir run / bike / row / ski.

## 47. Gestion des impacts

Volume d'impact approximatif : course ; box jumps ; double-unders ; burpees ; sauts. Un WOD de 150 DU + box jumps influence l'ajout de running.

## 48. Muscle / movement exposure map

Heatmap hebdomadaire muscles (quads, hamstrings, glutes, chest, back, shoulders, core) et patterns (squat, hinge, push, pull, carry, running, Olympic lift, gymnastics). Type et intensité du stimulus, pas seulement le nombre de séries.

## 49. Mode « JE VAIS AU CROSSFIT »

→ « Quel est le WOD ? » → import WOD Inbox → analyse → « Parfait. Cette séance couvre ton stimulus jambes + conditioning. » → bonus recommandé (aucun / 20–30 min Zone 2 plus tard) → replanification des jours suivants.

## 50–52. Modes « J'AI DU TEMPS », « JE SUIS CHAUD 🔥 », « J'AI LA FLEMME »

J'ai du temps : option productive / récupération / fun ; jamais temps disponible = obligation.
Je suis chaud : séance challenge (benchmark, WOD, trail, long ride, test, partner) si récup compatible.
J'ai la flemme : très peu de friction (20 min vélo facile ; EMOM fun ; run 30 min libre ; skill) ou repos total. Régularité, pas culpabilisation.

## 53. Calendrier

Vue semaine ; cartes type / durée / difficulté / état (PLANNED, DONE, SKIPPED, AUTO-ADJUSTED, CROSSFIT, COACHING, RECOVERY). Drag & drop → vérification moteur (déplacer « Heavy Legs » avant un gros WOD squat génère une alerte).

## 54. Synchronisation calendrier — CalendarProvider

Google Calendar ; Apple Calendar ; autre. Journées chargées, fenêtres, voyages, événements. Ne pas exposer le contenu privé à l'IA : transformer en fenêtres de disponibilité.

## 55. Voyages — TRAVEL

Destination ; dates ; matériel ; accès CrossFit/salle ; running ; vélo. Adaptation temporaire. Une semaine de voyage n'est pas « ratée ».

## 56. Compétitions — EVENT

CrossFit competition ; Hyrox ; running race ; trail ; cycling ; benchmark day ; other. Adaptation charge/taper/récup/spécifique.

## 57. Mode test — TEST_RESULT

Tests proposés lorsqu'utiles (5 km, 2 km row, 3RM squat, benchmark) avec conditions et contexte.

## 58. Auto-détection des PR

PR distance/temps/pace/poids/reps/e1RM/benchmark après import ou séance. Célébration simple, pas de gamification infantilisante.

## 59–60. Weekly / Monthly review

Weekly : heures, comptes par type, ce qui progresse, attention, fun, ligne « semaine prochaine ». Monthly : synthèse plus complète, éventuellement en langage naturel par l'IA à partir de données structurées.

## 61. Chat coach IA

« Je veux quelque chose de fun ce soir » ; « Pourquoi du vélo ? » ; « CrossFit demain ? » ; « J'ai 90 minutes » ; « Mes jambes sont mortes » ; « Je veux essayer Fran ». L'IA dispose seulement des données nécessaires via des outils serveur (programme, historique, readiness, métriques, objectifs).

## 62–63. Explication et confiance

Bouton POURQUOI ? : explications courtes, factuelles, compréhensibles. Confiance HIGH / MEDIUM / LOW ; en cas de LOW, pas de fausse précision.

## 64. Stack

Next.js, TypeScript, App Router, React, Tailwind, PWA ; server routes/actions ; PostgreSQL (Supabase si adapté) ; Supabase Auth ou équivalent ; Vercel ; Vercel Cron ; logs structurés ; gestion des erreurs.

## 65. Entités principales

User, AthleteProfile, Goal, TrainingBlock, Workout, WorkoutTemplate, WorkoutExercise, Exercise, StrengthSet, CardioWorkout, CrossfitWorkout, WodAnalysis, Activity, ActivityLap, ActivityStream, DailyReadiness, RecoveryMetric, BodyComposition, PainLog, CoachSession, Event, PersonalRecord, Benchmark, Stimulus, WorkoutStimulus, WeeklyStimulusTarget, Integration, GarminConnection, SyncJob, AIRecommendation, UserPreference, AvailabilityWindow. Normaliser intelligemment sans complexité inutile.

## 66. Exercise model

id, name, aliases, category, movementPattern, primaryMuscles, secondaryMuscles, equipment, measurementType, defaultIncrement, technicalDifficulty, impactLevel. Aliases (DL, dead lift, deadlift → DEADLIFT).

## 67. Workout normalization

Tout entraînement finit dans `Workout` (type, source, startTime, duration, planned, completed, rpe, funScore, notes) + détails par discipline. Calendrier unique.

## 68–70. Raw data, metric versioning, data quality

Garder données normalisées + référence brute + version de parser + date d'import. Métriques calculées : metricName, value, unit, algorithmVersion, calculatedAt (`aerobic_decoupling_v2`). Chaque donnée importée : source (GARMIN, USER, AI_PARSED, CALCULATED, SCALE, MANUAL), confidence, timestamp. Une donnée estimée n'apparaît jamais comme mesurée.

## 71. Privacy

HTTPS ; secrets serveur ; OAuth ; permissions minimales ; export ; suppression ; logs sans données sensibles inutiles ; aucune clé API côté client.

## 72–74. Garmin implémentation, FitParser, synchronisation

Interface abstraite (`getActivities`, `getActivity`, `getHealthData`, `createWorkout`, `scheduleWorkout`, `disconnect`). Ne pas inventer d'endpoints : consulter la doc officielle au moment de l'implémentation. `FitParser` tolérant (session, laps, records, HR, cadence, speed, power, running dynamics, altitude, distance).
Workflow : webhook/sync → enqueue → fetch → deduplicate → store raw → normalize → metrics → training state → recompute recommendations. Tout idempotent.

## 75–76. Temps réel vs background, offline

Instant : affichage, saisie série, timer, workout. Background : FIT parsing, historique, stats, analyses, recommandations futures. Séance musculation fonctionnelle hors ligne (séance, sets, timer, modifications conservés localement, sync ensuite).

## 77–79. UX musculation, rest timer, autoload

Écran : BACK SQUAT · Set 3/5 · 5 reps · 92.5 kg · Last 90×5 @8 · Target RPE 7–8 · [−2.5] [DONE] [+2.5] → RPE ? [Easy][Perfect][Hard] → timer. Timer selon travail (force lourde 2:30–5:00 ; hypertrophie 1:00–2:30 ; circuit selon prescription) avec skip / +30 s / start now. Autoload déterministe : « +2.5 kg proposé », pas « l'IA pense que 87.3 kg ».

## 80–81. Cardio workout builder, Garmin push UX

Étapes ciblant HR zone / pace / power / cadence / duration / distance / open, transformées vers le format Garmin Training API. UX : ✓ Workout synced, watch, scheduled ; si échec Retry ; ne jamais perdre la séance.

## 82–83. Automatisation et notifications

Matin sync récup ; après activité import auto ; après CrossFit analyse + RPE rapide ; soir update ledger ; dimanche weekly review. Notifications seulement si utiles, réglages fins.

## 84–88. Home simple, design, navigation, command palette, search

Home = TODAY, Training, Recovery, 1 insight. Design premium, sportif, minimal, dark mode travaillé, grandes zones tactiles, une main, animations légères. Navigation : TODAY · CALENDAR · TRAIN (Strength / Cardio / CrossFit / Free) · PROGRESS · PROFILE. Palette « + » : Add CrossFit WOD ; Start Strength ; Start Cardio ; Log activity ; Coach CrossFit ; Rest day ; Pain ; Body measurement. Recherche globale exercice / WOD / activité / benchmark.

## 89–90. Onboarding et baseline period

Onboarding court : objectifs ; sports ; disponibilités ; niveau/PR ; Garmin. Premières semaines : « Athlete OS apprend ton profil », plus conservateur.

## 91–95. Données imparfaites, santé, douleur, recovery, long terme

Ne jamais faire dépendre un changement important d'une variation isolée d'une métrique bruitée. Santé = pouvoir pratiquer des décennies (récupération, masse musculaire, cardio, mobilité, variété, absence de douleurs chroniques, plaisir), pas un score pseudo-médical. Douleur : location, 0–10, movement-specific, sudden, persistent → réduire/remplacer, ne pas diagnostiquer, recommander consultation si justifié. Recovery : walk / easy bike / mobility / easy swim / nothing. CURRENT FOCUS (Base / Build / Performance / Recovery) jamais « Jour 38/90 ».

## 96. Success metrics

1) Je sais toujours quoi faire ; 2) presque rien à saisir ; 3) CrossFit et autres entraînements ne se battent pas ; 4) je progresse objectivement ; 5) je vois pourquoi ; 6) fatigue gérée ; 7) plaisir ; 8) envie durable.

## 97. MVP

**MVP 1** : Auth ; Athlete profile ; Today ; Calendar ; Manual CrossFit WOD ; AI WOD parser ; Strength workouts ; Strength sets ; RPE ; Basic cardio workouts ; Exposure ledger ; Adaptive recommendation engine v1 ; Basic progress charts ; GarminProvider abstraction ; Mock Garmin ; FIT import manuel ; PWA.
**MVP 2** : Garmin official ; Activity sync ; Training API ; Health data ; Readiness ; Advanced cardio analytics.
**MVP 3** : Body composition provider ; Advanced engine ; Chat Coach ; Weekly/monthly reviews ; Travel/events ; Advanced CrossFit analytics.

## 98. Ordre de développement

1) architecture ; 2) modèle de données ; 3) types TypeScript ; 4) règles du moteur ; 5) prototype Today ; 6) Strength Mode ; 7) WOD Inbox ; 8) Calendar ; 9) Analytics ; 10) Garmin. Expliquer l'architecture avant chaque gros module.

## 99. Tests

Le moteur est critique. Ex. : hier heavy squat + wall balls, aujourd'hui CrossFit avec front squats → pas d'accessoire jambes lourd. Deux jours faciles + bonne récup + VO2 manquant → VO2 possible. « I want to run » + impact acceptable → réorganiser et offrir run. Hard run demandé + impact élevé + récup mauvaise → alternative.

## 100. Logique explicable

Chaque recommandation conserve inputs, rulesTriggered, output, explanation (ex. `HIGH_LOWER_BODY_LOAD_48H`, `WEEKLY_AEROBIC_VOLUME_BELOW_TARGET`, `HIGH_IMPACT_LOAD`).

## 101. Feature flags

Garmin ; AI coach ; body composition ; advanced readiness ; experimental metrics.

## 102. Principe personnel

Trouver continuellement la meilleure dose et le meilleur type d'entraînement pour mes objectifs, mon corps, mes performances, ma récupération et mes envies. **Le programme s'adapte à l'athlète, pas l'inverse.**

## 103. Demande

Analyser ; décisions techniques ; architecture MVP ; schéma DB ; architecture du moteur ; séparer mesuré / déclaré / estimé / décisions moteur / décisions IA ; APIs externes ; validations externes (Garmin) ; construire étape par étape ; tests + TypeScript + lint + build après chaque étape. Ni sacrifice de l'architecture long terme pour une démo, ni sur-ingénierie prématurée. Un excellent Athlete OS personnel d'abord.
