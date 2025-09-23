from flask import Flask, render_template, jsonify, request, abort
from models import db, Board, Note, Project
import os

app = Flask(__name__, static_folder='static')
BASE_DIR = os.path.dirname(__file__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(BASE_DIR, 'db.sqlite')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

# @app.before_first_request
# def create_tables():
if __name__ == '__main__':
    with app.app_context():
        db.create_all()

        # Ensure at least one project exists
        if Project.query.count() == 0:
            default_project = Project(name="Default Project")
            db.session.add(default_project)
            db.session.commit()
        else:
            default_project = Project.query.first()

        # Ensure at least one board exists
        if Board.query.count() == 0:
            b = Board(name='Default', project=default_project)  # ✅ link to project
            db.session.add(b)
            db.session.commit()


# --- ROUTES ---

@app.route('/', methods=['GET'])
def project_index():
    return render_template('project_index.html')


@app.route('/api/projects', methods=['GET'])
def list_projects():
    projects = Project.query.order_by(Project.id).all()
    return jsonify([
        {"id": p.id, "name": p.name, "pin": p.pin}
        for p in projects
    ])


@app.route('/api/projects/<int:project_id>', methods=['GET'])
def get_project(project_id):
    project = Project.query.get_or_404(project_id)
    return jsonify({
        "id": project.id,
        "name": project.name,
        "pin": bool(project.pin)
    })


@app.route('/api/projects', methods=['POST'])
def create_project():
    data = request.json or {}
    name = data.get("name")

    if not name:
        abort(400, "Project name required")
    
    pin = data.get("pin")
    if pin and len(pin) != 4:
        abort(400, "PIN must be exactly 4 digits")

    if pin and not pin.isdigit():
        abort(400, "PIN must only contain digits")

    project = Project(name=name, pin=pin)
    db.session.add(project)
    db.session.commit()
    return jsonify({"id": project.id, "name": project.name, "pin": bool(project.pin)}), 201

@app.route('/project/<name>')
@app.route('/project/<name>/<pin>')
def open_project(name, pin=None):
    project = Project.query.filter_by(name=name).first_or_404()
    if project.pin and project.pin != pin:
        abort(403, "Invalid PIN")

    if request.method == "HEAD":
        return "", 200  # lightweight check

    return render_template("index.html", project_id=project.id)


@app.route('/api/projects/<int:project_id>', methods=['PATCH'])
def update_project(project_id):
    project = Project.query.get_or_404(project_id)
    data = request.json or {}
    if 'name' in data:
        project.name = data['name']
    db.session.commit()
    return jsonify({'id': project.id, 'name': project.name})


@app.route('/api/projects/<int:project_id>/boards')
def list_boards(project_id):
    project = Project.query.get_or_404(project_id)
    boards = project.boards
    return jsonify([
        {"id": b.id, "name": b.name, "background_color": b.background_color, "snapping": b.snapping}
        for b in boards
    ])

@app.route('/api/projects/<int:project_id>/boards', methods=['POST'])
def create_board(project_id):
    project = Project.query.get_or_404(project_id)
    data = request.json or {}
    name = data.get('name', 'Untitled')
    b = Board(name=name, project=project)
    db.session.add(b)
    db.session.commit()
    return jsonify({'id': b.id, 'name': b.name}), 201

@app.route('/api/boards/<int:board_id>', methods=['PATCH'])
def update_board(board_id):
    b = Board.query.get_or_404(board_id)
    data = request.json or {}
    if 'background_color' in data:
        b.background_color = data['background_color']
    if 'name' in data:
        b.name = data['name']
    if 'snapping' in data:
        b.snapping = bool(data['snapping'])
    db.session.commit()
    return jsonify({
        'status': 'ok',
        'id': b.id,
        'background_color': b.background_color,
        'name': b.name,
        'snapping': b.snapping
    })

@app.route("/api/boards/reorder", methods=["PATCH"])
def reorder_boards():
    data = request.json.get("order", [])
    for item in data:
        board = Board.query.get(item["id"])
        if board:
            board.position = item["position"]
    db.session.commit()
    return jsonify({"status": "ok"})

@app.route('/api/boards/<int:board_id>', methods=['DELETE'])
def delete_board(board_id):
    board = Board.query.get_or_404(board_id)

    # Optional safeguard: prevent deleting the last board
    if Board.query.count() <= 1:
        abort(400, "At least one board must exist")

    # Delete all notes belonging to this board
    for n in board.notes:
        db.session.delete(n)

    db.session.delete(board)
    db.session.commit()
    return jsonify({'status': 'deleted'})

@app.route('/api/boards/<int:board_id>/duplicate', methods=['POST'])
def duplicate_board(board_id):
    board = Board.query.get_or_404(board_id)

    new_board = Board(
        name=f"{board.name} (copy)",
        background_color=board.background_color,
        snapping=board.snapping,
        project_id=board.project_id  # 👈 ensure it belongs to the same project
    )

    db.session.add(new_board)
    db.session.flush()  # so new_board.id is available before commit

    for n in board.notes:
        copy_note = Note(
            board_id=new_board.id,
            content=n.content,
            x=n.x,
            y=n.y,
            width=n.width,
            height=n.height,
            color=n.color,
            z_index=n.z_index,
        )
        db.session.add(copy_note)

    db.session.commit()
    return jsonify({"id": new_board.id, "name": new_board.name}), 201

@app.route('/api/boards/<int:board_id>/move', methods=['PATCH'])
def move_board(board_id):
    board = Board.query.get_or_404(board_id)
    data = request.json or {}
    new_project_id = data.get("project_id")
    if not new_project_id:
        abort(400, "project_id required")

    project = Project.query.get(new_project_id)
    if not project:
        abort(404, "Target project not found")

    board.project_id = new_project_id
    db.session.commit()
    return jsonify({
        "status": "ok",
        "id": board.id,
        "project_id": board.project_id
    })


@app.route('/api/boards/<int:board_id>/notes')
def get_notes(board_id):
    board = Board.query.get_or_404(board_id)
    notes = []
    for n in board.notes:
        notes.append({
            'id': n.id,
            'content': n.content,
            'x': n.x,
            'y': n.y,
            'width': n.width,
            'height': n.height,
            'color': n.color,
            'z_index': n.z_index,
        })
    return jsonify(notes)

@app.route('/api/notes', methods=['POST'])
def create_note():
    data = request.json or {}
    board_id = data.get('board_id')
    if not board_id or not Board.query.get(board_id):
        abort(400, 'board_id required')
    n = Note(
        board_id=board_id,
        content=data.get('content', ''),
        x=data.get('x', 50),
        y=data.get('y', 50),
        width=data.get('width', 200),
        height=data.get('height', 150),
        color=data.get('color', '#FFF59D')
    )
    db.session.add(n)
    db.session.commit()
    return jsonify({'id': n.id}), 201

@app.route('/api/notes/<int:note_id>', methods=['PATCH'])
def update_note(note_id):
    if note_id == 0:  # dummy note for scrolling
        return jsonify({'status': 'ok'})
    
    n = Note.query.get_or_404(note_id)
    data = request.json or {}
    for k in ('content', 'x', 'y', 'width', 'height', 'color', 'z_index',
              'font', 'font_color', 'size', 'h_align', 'transparent_colors'):
        if k in data:
            setattr(n, k, data[k])
    db.session.commit()
    return jsonify({'status': 'ok'})

@app.route('/api/notes/<int:note_id>', methods=['DELETE'])
def delete_note(note_id):
    n = Note.query.get_or_404(note_id)
    db.session.delete(n)
    db.session.commit()
    return jsonify({'status': 'deleted'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=1906, debug=True)
