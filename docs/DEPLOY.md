# Mettre Athlete OS en ligne et bien démarrer

Ce guide couvre tout ce que tu dois faire toi-même, dans l'ordre. Compte environ une heure pour les étapes 1 à 5.
Les étapes 6 et 7 sont indépendantes : la demande Garmin prend quelques minutes puis un délai d'approbation.

| Étape | Durée | Obligatoire |
| --- | --- | --- |
| 1. Supabase : base de données et connexion | 15 min | oui |
| 2. Vercel : hébergement | 15 min | oui |
| 3. Relier Supabase à l'adresse du site | 2 min | oui |
| 4. Installer l'app sur l'iPhone et faire l'onboarding | 15 min | oui |
| 5. Vérifier que tout tourne | 5 min | oui |
| 6. Demander l'accès aux API Garmin | 15 min + attente | conseillé |
| 7. Brancher l'IA d'Anthropic pour lire les WOD | 10 min | optionnel |

Les deux services sont gratuits pour cet usage : Supabase en offre gratuite, Vercel en offre Hobby.

**Règle de sécurité.** Garde les secrets dans un gestionnaire de mots de passe : mot de passe de la base, les deux URL de base de
données, `CRON_SECRET` et, plus tard, les clés Garmin et Anthropic. Ne les colle jamais dans une conversation, une issue GitHub
ou le code. Leur seule place en ligne est l'écran des variables d'environnement de Vercel.

---

## 1. Supabase : base de données et connexion

### 1.1 Créer le projet

1. Va sur [supabase.com](https://supabase.com) et connecte-toi, par exemple avec ton compte GitHub.
2. Clique sur **New project**.
3. Nom : `athlete-os`.
4. **Database Password** : clique sur *Generate a password*. Garde uniquement un mot de passe fait de lettres et de chiffres,
   24 caractères ou plus. Un caractère spécial comme `@`, `/`, `:` ou `#` casse l'URL de connexion. Enregistre-le tout de suite.
5. **Region** : *West EU (Paris)*. Les serveurs de l'app sont réglés sur Paris, la base doit être à côté.
6. Clique sur **Create new project** et attends que le projet soit prêt, environ deux minutes.

### 1.2 Récupérer les deux adresses de la base

1. En haut du tableau de bord du projet, clique sur **Connect**.
2. Onglet des chaînes de connexion, format **URI**. Tu vois trois variantes.
3. Copie **Transaction pooler**, port `6543` : c'est `DATABASE_URL`, utilisée par l'app.
4. Copie **Session pooler**, port `5432`, hôte en `pooler.supabase.com` : c'est `DIRECT_DATABASE_URL`, utilisée pour
   installer et mettre à jour les tables à chaque déploiement.
5. Dans les deux, remplace `[YOUR-PASSWORD]` par ton mot de passe.

N'utilise pas **Direct connection** (hôte `db.xxxx.supabase.co`) : elle ne fonctionne qu'en IPv6 et Vercel ne peut pas la joindre.

Les deux adresses ont cette forme, copie l'hôte exact affiché par Supabase :

```
postgresql://postgres.abcdefghijklmnop:TonMotDePasse@aws-0-eu-west-3.pooler.supabase.com:6543/postgres
postgresql://postgres.abcdefghijklmnop:TonMotDePasse@aws-0-eu-west-3.pooler.supabase.com:5432/postgres
```

### 1.3 Récupérer l'adresse du projet et la clé publique

Dans le même panneau **Connect**, l'onglet des frameworks d'application, choix *Next.js*, affiche les deux valeurs prêtes à
copier. Tu les trouves aussi dans **Project Settings**, rubriques *Data API* pour l'adresse et *API Keys* pour la clé.

- `NEXT_PUBLIC_SUPABASE_URL` : l'adresse du projet, de la forme `https://abcdefghijklmnop.supabase.co`.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` : la clé **publishable** (`sb_publishable_…`) ou, dans l'onglet *Legacy API Keys*, la clé
  **anon** (longue chaîne commençant par `eyJ`). Les deux formats fonctionnent. Garde ce nom de variable même si Supabase
  l'appelle autrement.

Cette clé est publique par conception. Tes données restent protégées : chaque table a la sécurité par ligne activée sans
aucune règle d'accès, et l'app ne lit la base que depuis son serveur.

**Optionnel.** La clé **secret** (`sb_secret_…`) ou **service_role** va dans `SUPABASE_SERVICE_ROLE_KEY`. Elle sert
uniquement à ce que « Supprimer mon compte » efface aussi ton identifiant de connexion. Tu peux t'en passer. Si tu la mets,
c'est le secret le plus sensible du projet.

### 1.4 Fermer les inscriptions

**Authentication**, rubrique **Sign In / Providers** : désactive **Allow new users to sign up**. Laisse le fournisseur *Email*
activé. L'app n'a de toute façon aucun écran d'inscription et refuse tout email absent de `ALLOWED_EMAILS`.

### 1.5 Créer ton compte

1. **Authentication**, rubrique **Users**, bouton **Add user**, puis **Create new user**.
2. Ton email et un mot de passe.
3. Coche **Auto Confirm User**, puis crée l'utilisateur.

Ne supprime jamais cet utilisateur une fois que tu t'es servi de l'app : toutes tes données sont rattachées à son identifiant.

### 1.6 Conseillé : la connexion par code

L'écran de connexion propose « Recevoir un code par email à la place ». C'est aussi ta porte de secours si tu oublies ton
mot de passe, car l'app n'a pas d'écran de réinitialisation. Pour que l'email contienne un code à six chiffres :

1. **Authentication**, rubrique **Emails**, modèle **Magic Link**.
2. Remplace le contenu par :

```html
<h2>Ton code Athlete OS</h2>
<p>Code : <strong>{{ .Token }}</strong></p>
<p>Saisis-le dans l'app. Il n'est valable que peu de temps.</p>
```

3. Enregistre. L'envoi d'emails intégré à Supabase est limité à quelques messages par heure, largement assez pour toi.

---

## 2. Vercel : hébergement

### 2.1 Importer le dépôt

1. Va sur [vercel.com](https://vercel.com), **Sign Up**, **Continue with GitHub**, offre **Hobby**.
2. **Add New…**, **Project**, puis importe `NMARILLOT/Athlete-OS`. S'il n'apparaît pas, clique sur le lien d'ajustement des
   permissions de l'application GitHub et autorise ce dépôt.
3. Écran de configuration : le framework détecté est **Next.js**. Ne touche ni à la commande de build, ni au dossier de
   sortie, ni à la commande d'installation.

### 2.2 Renseigner les variables

Ouvre **Environment Variables**. Tu peux coller tout le bloc ci-dessous d'un coup dans le premier champ *Key* : Vercel le
découpe ligne par ligne. Remplace chaque valeur entre chevrons.

```
AUTH_MODE=supabase
DATABASE_URL=<Transaction pooler, port 6543, avec ton mot de passe>
DIRECT_DATABASE_URL=<Session pooler, port 5432, avec ton mot de passe>
NEXT_PUBLIC_SUPABASE_URL=<https://….supabase.co>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<clé publishable ou anon>
ALLOWED_EMAILS=<l'email de ton compte Supabase>
CRON_SECRET=<40 caractères aléatoires, lettres et chiffres>
AI_PROVIDER=mock
GARMIN_PROVIDER=mock
FLAG_GARMIN=false
```

Pour `CRON_SECRET`, génère 40 caractères avec ton gestionnaire de mots de passe, ou lance `openssl rand -hex 32` dans le
Terminal d'un Mac. Vercel l'envoie lui-même au recalcul quotidien, tu n'as pas à le retenir.

### 2.3 Déployer

Clique sur **Deploy**. Le build prend deux à trois minutes. Avant de compiler, il vérifie tes variables, crée les tables
et charge le catalogue d'exercices. Dans le journal du build, tu dois voir :

```
[predeploy] migrations appliquées.
[predeploy] données de référence à jour : 97 exercices, 663 alias, 8 benchmarks, 6 modèles.
```

Si tu vois `[predeploy] ÉCHEC`, le message dit quoi corriger. Corrige la variable dans **Settings**, **Environment
Variables**, puis relance : onglet **Deployments**, menu `⋯` du dernier déploiement, **Redeploy**.

### 2.4 Contrôles dans Vercel

- **Settings**, **Git** : la branche de production est `claude/athlete-os-training-app-j5dkgm`, la branche par défaut du dépôt.
  Chaque modification que je pousse sur cette branche part en production automatiquement.
- **Settings**, **Cron Jobs** : `/api/cron/daily` apparaît. Il recalcule ta journée une fois par jour, vers 6 h à Paris.
  En offre Hobby, l'heure exacte peut varier dans l'heure.
- **Settings**, **Functions** : la région est Paris (`cdg1`). Elle vient du fichier `vercel.json`.
- Toute modification d'une variable ne s'applique qu'après un **Redeploy**.

---

## 3. Relier Supabase à l'adresse du site

Ton site a une adresse de la forme `https://athlete-os-xxxx.vercel.app`, visible sur la page du projet Vercel.

Dans Supabase, **Authentication**, rubrique **URL Configuration** : mets cette adresse dans **Site URL** et enregistre.

---

## 4. Installer l'app sur l'iPhone et faire l'onboarding

1. Ouvre l'adresse du site dans **Safari**.
2. Touche **Partager**, puis **Sur l'écran d'accueil**, puis **Ajouter**. L'app affiche d'ailleurs un rappel la première fois.
3. Ouvre Athlete OS **depuis l'icône** et connecte-toi là. L'app installée a son propre stockage, séparé de Safari : une
   connexion faite dans Safari ne la suit pas. C'est aussi ce stockage qui permet à la séance de force de marcher hors ligne.
4. Fais l'onboarding, cinq écrans, environ dix minutes :
   - **Objectifs** : le poids de chaque objectif, et tes objectifs du moment comme un 10 km, Hyrox ou le muscle-up.
   - **Sports et matériel** : ce que tu aimes, ta box, ta salle, ton matériel à la maison.
   - **Disponibilités** : tes créneaux habituels, ton volume hebdomadaire visé, ton nombre maximal de séances dures.
   - **Niveau** : tes 1RM approximatifs. Ils servent de point de départ aux charges proposées ; une estimation suffit.
     Ajoute aussi ta **FC au seuil (LTHR)** si tu la connais : sans elle, les zones cardio restent « à renseigner ». Si ta
     montre l'a estimée avec la ceinture HRM-Pro, tu la trouves dans Garmin Connect, rubrique des statistiques de
     performances, *Seuil lactique*.
   - **Garmin** : rien à faire pour l'instant, termine.

Pendant les trois premières semaines, l'app affiche « Athlete OS apprend ton profil » et reste prudente. Une confiance
« faible » est normale au début.

---

## 5. Vérifier que tout tourne

- `https://ton-adresse.vercel.app/api/health` doit afficher `{"ok":true}`.
- L'écran **Aujourd'hui** propose une séance principale avec une explication.
- Démarre une séance de force depuis **Train**, valide une série, termine. Elle apparaît dans « Fait aujourd'hui ».
- Le lendemain matin, **Vercel**, **Logs** : une exécution de `/api/cron/daily` avec un statut 200.

---

## 6. Demander l'accès aux API Garmin

Les API officielles de Garmin passent par le **Garmin Connect Developer Program**. Sans elles, l'app fonctionne avec l'import
de fichiers FIT.

1. Va sur [developer.garmin.com](https://developer.garmin.com), section *Garmin Connect Developer Program*, puis le
   formulaire de demande d'accès.
2. Demande trois API :
   - **Activity API** : activités terminées, fichiers FIT, fréquence cardiaque, allure, puissance, dynamiques de course.
   - **Health API** : sommeil, variabilité cardiaque, FC de repos, stress, Body Battery.
   - **Training API** : envoi des séances structurées et du calendrier vers ta montre.
3. Le programme vise en principe les entreprises : le formulaire demande une société et un site. Si tu as une structure,
   utilise-la. Une demande purement personnelle peut être refusée ; l'import FIT reste alors la solution.
4. Description d'usage, en anglais, prête à coller :

> Athlete OS is a private adaptive training application for a single athlete who combines CrossFit, strength and endurance
> training. It uses the Activity API to import completed activities and FIT files (heart rate, pace, power, running
> dynamics), the Health API to read daily recovery metrics (sleep, HRV, resting heart rate, stress, Body Battery) that
> adjust the daily training recommendation, and the Training API to send structured running, cycling and rowing workouts to
> the athlete's Garmin calendar and watch. Data is stored in a private database, used only for this athlete's training,
> never shared or sold, and deleted on request. Expected users: 1.

5. Si c'est accepté, Garmin te donne un identifiant et un secret. Mets-les **uniquement** dans Vercel, dans
   `GARMIN_CLIENT_ID` et `GARMIN_CLIENT_SECRET`, puis demande-moi de construire la connexion officielle : autorisation de
   ton compte Garmin, réception automatique des activités et envoi des séances à la montre.

### En attendant : importer tes fichiers FIT

1. Dans un navigateur, ouvre [connect.garmin.com](https://connect.garmin.com), puis l'activité voulue.
2. Menu engrenage de l'activité, **Exporter l'original** : tu obtiens un fichier `.zip`.
3. Sur iPhone, dans l'app **Fichiers**, touche le `.zip` pour en extraire le fichier `.fit`.
4. Dans Athlete OS : bouton **+**, **Importer un fichier FIT**, choisis le `.fit`.

L'app relie l'activité à la séance prévue le même jour quand le sport correspond, calcule tes zones, ton efficacité aérobie
et tes records. Les séries détaillées (fréquence cardiaque, allure, altitude…) sont conservées pour les recalculs futurs ;
le fichier lui-même n'est pas stocké, garde-le dans Garmin Connect.

---

## 7. Optionnel : l'IA d'Anthropic pour lire les WOD

Sans clé, un analyseur intégré lit les formats courants : For time, AMRAP, EMOM, séries par répétitions. Avec une clé, les
textes de box plus désordonnés passent mieux. Dans les deux cas, l'app te montre la structure lue pour validation, et l'IA
ne décide jamais de la charge d'entraînement : c'est le moteur de règles qui s'en charge.

1. Va sur [console.anthropic.com](https://console.anthropic.com) et crée un compte.
2. Ajoute du crédit dans la facturation, puis fixe une **limite de dépense mensuelle** dans les réglages de limites.
3. Crée une clé API. Elle ne s'affiche qu'une fois.
4. Dans Vercel, modifie `AI_PROVIDER=anthropic` et ajoute `ANTHROPIC_API_KEY=` suivi de ta clé, puis **Redeploy**.

L'app plafonne elle-même l'usage : 30 analyses de WOD et 50 phrases d'envie par 24 heures, avec réutilisation des analyses
déjà faites. Au-delà, ou en cas de panne, l'analyseur intégré prend le relais. Le modèle par défaut est `claude-opus-5-5` ;
tu peux mettre `AI_MODEL_PARSER=claude-sonnet-5-5` pour réduire le coût.

---

## 8. Au quotidien

- **Le matin**, environ 30 secondes : sur **Aujourd'hui**, touche « Comment tu te sens ? », trois réponses. La
  recommandation se recalcule.
- **La séance** : **START**. Si elle ne te convient pas, le bouton de rafraîchissement propose une autre option, les
  pastilles « Envie de… » disent ce que tu veux ou refuses, et tu peux écrire « j'ai envie de… ». Le bouton **?**
  explique le choix.
- **CrossFit** : dès que ta box publie le WOD, bouton **+**, **Ajouter un WOD CrossFit**, colle le texte, vérifie, puis « C'est ça, je
  le fais ». Si tu ne connais pas encore le WOD, touche « Je vais au CrossFit ».
- **Après chaque séance**, moins de dix secondes : ton ressenti, ton RPE, une douleur inhabituelle ou non.
- **La force** marche hors ligne : sans réseau, les séries sont gardées sur le téléphone et envoyées dès que la connexion
  revient.
- **Course, vélo, rameur** : crée la séance depuis **Train**, puis importe le fichier FIT après coup, tant que Garmin n'est
  pas branché.
- **Une douleur** : bouton **+**, **Signaler une douleur**. Le moteur allège ou remplace ce qui la sollicite ; il ne pose
  aucun diagnostic.
- **Chaque semaine** : **Calendar** pour voir et déplacer tes séances avec l'avis du moteur, **Progress** pour tes courbes.
- **Chaque mois** : **Profile**, **Données**, **Exporter**. L'offre gratuite de Supabase a des sauvegardes limitées ; cet
  export JSON est ta copie personnelle.

---

## 9. Ce qu'il faut me renvoyer après une ou deux semaines

- Les jours où la recommandation t'a semblé fausse : la date, ce qu'elle proposait, ce que tu attendais et pourquoi.
- Les écrans lents ou trop chargés, avec une capture.
- Les WOD mal lus, avec le texte collé.
- La réponse de Garmin.

---

## 10. Dépannage

| Ce que tu vois | Cause probable | Que faire |
| --- | --- | --- |
| Build : `[predeploy] ÉCHEC — Variables d'environnement de production invalides` | Variable absente ou mal écrite | Corrige les variables listées dans Vercel, puis **Redeploy** |
| Build : `Base de données injoignable ou refusée` | URL *Direct connection* au lieu de *Session pooler*, mot de passe erroné ou non remplacé, projet en pause | Recopie l'URL *Session pooler*, vérifie le mot de passe, relance le projet Supabase |
| « Ce compte n'est pas autorisé » | Email absent de `ALLOWED_EMAILS` | Corrige la variable, puis **Redeploy** |
| « Email ou mot de passe incorrect » | Mot de passe | Utilise la connexion par code, étape 1.6 |
| « Email non confirmé » | *Auto Confirm User* non coché | Si tu ne t'es encore jamais connecté, supprime et recrée l'utilisateur avec la case cochée |
| « Impossible de joindre le service de connexion » | `NEXT_PUBLIC_SUPABASE_URL` ou la clé erronée | Corrige, puis **Redeploy** : ces deux valeurs sont intégrées au moment du build |
| Page « Un problème est survenu » | Erreur serveur | Vercel, **Logs**, et vérifie `/api/health` |
| Plus de recalcul quotidien | `CRON_SECRET` absent | Ajoute-le, puis **Redeploy** |
| Le site ne répond plus après des jours sans usage | Projet Supabase gratuit mis en pause | Relance-le depuis le tableau de bord Supabase ; les données sont conservées |

---

## Récapitulatif des variables

| Variable | Obligatoire | Où la trouver | Secrète |
| --- | --- | --- | --- |
| `AUTH_MODE` | oui | valeur fixe `supabase` | non |
| `DATABASE_URL` | oui | Supabase, **Connect**, *Transaction pooler* | oui |
| `DIRECT_DATABASE_URL` | oui | Supabase, **Connect**, *Session pooler* | oui |
| `NEXT_PUBLIC_SUPABASE_URL` | oui | Supabase, **Connect** ou *Data API* | non |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | oui | Supabase, *API Keys* : publishable ou anon | non |
| `ALLOWED_EMAILS` | oui | ton email de connexion ; plusieurs possibles, séparés par des virgules | non |
| `CRON_SECRET` | oui | à générer | oui |
| `SUPABASE_SERVICE_ROLE_KEY` | non | Supabase, *API Keys* : secret ou service_role | oui |
| `AI_PROVIDER` / `ANTHROPIC_API_KEY` | non | `mock` par défaut ; clé depuis la console Anthropic | la clé, oui |
| `GARMIN_PROVIDER` / `FLAG_GARMIN` | non | `mock` et `false` tant que Garmin n'a pas répondu | non |
